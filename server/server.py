
import os
import time
import uuid
import threading

from datetime import datetime, timedelta, timezone
from functools import wraps

import requests
from flask import Flask, request, jsonify, Response, stream_with_context
from sqlalchemy import create_engine, String, DateTime, Integer, select, delete
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


app = Flask(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///requests.db")
IMMICH_URL = os.getenv("IMMICH_URL", "http://localhost:2283").rstrip("/")
IMMICH_API_TOKEN = os.environ["IMMICH_API_TOKEN"]

engine = create_engine(DATABASE_URL)
Session = sessionmaker(engine)

CLEANUP_INTERVAL = 3600
RETENTION = timedelta(days=2)
last_cleanup = 0.0
cleanup_lock = threading.Lock()


class Base(DeclarativeBase):
    pass


class AssetRequest(Base):
    __tablename__ = "asset_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    client_id: Mapped[str] = mapped_column(String, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, index=True)
    asset_id: Mapped[str] = mapped_column(String, index=True)


Base.metadata.create_all(engine)


def now():
    return datetime.now(timezone.utc)


def parse_date(value):
    """Parse ISO-8601 and normalize to naive UTC for SQLite."""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("Timestamp must include timezone")
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def iso_date(value):
    return value.replace(tzinfo=timezone.utc).isoformat()


def authenticated(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        username = request.headers.get(
            "X-Auth-Request-Preferred-Username"
        )
        if not username:
            return jsonify(error="Unauthorized"), 401

        return fn(*args, username=username, **kwargs)

    return wrapper


def cleanup():
    global last_cleanup

    with cleanup_lock:
        current = time.monotonic()
        if current - last_cleanup < CLEANUP_INTERVAL:
            return

        cutoff = (now() - RETENTION).replace(tzinfo=None)

        with Session.begin() as db:
            db.execute(
                delete(AssetRequest).where(
                    AssetRequest.timestamp < cutoff
                )
            )

        last_cleanup = current


def immich_request(method, path, **kwargs):
    return requests.request(
        method,
        f"{IMMICH_URL}/api{path}",
        headers={"x-api-key": IMMICH_API_TOKEN},
        timeout=30,
        **kwargs,
    )


def valid_uuid(value):
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def serialize(entry):
    return {
        "id": entry.id,
        "Name": entry.name,
        "ClientIdentifier": entry.client_id,
        "DateTime": iso_date(entry.timestamp),
        "RequestedAssetId": entry.asset_id,
    }


# POST /requests
@app.post("/requests")
@authenticated
def create_request(username):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Invalid JSON"), 400

    try:
        asset_id = valid_uuid(data["RequestedAssetId"])
        if not asset_id:
            raise ValueError("Invalid asset UUID")

        timestamp = parse_date(data["DateTime"])
        name = data["Name"]
        client_id = data["ClientIdentifier"]

        if not isinstance(name, str) or not isinstance(client_id, str):
            raise ValueError("Invalid name or client identifier")

    except (KeyError, TypeError, ValueError) as exc:
        return jsonify(error=str(exc)), 400

    cleanup()

    with Session.begin() as db:
        entry = AssetRequest(
            name=name,
            client_id=client_id,
            timestamp=timestamp,
            asset_id=asset_id,
        )
        db.add(entry)
        db.flush()
        result = serialize(entry)

    return jsonify(result), 201


# GET /requests?minutes=60
# GET /requests?start=...&end=...
# Optional: &client_id=...
@app.get("/requests")
@authenticated
def list_requests(username):
    try:
        minutes = request.args.get("minutes", type=float)
        start = request.args.get("start")
        end = request.args.get("end")
        client_id = request.args.get("client_id")

        if "minutes" in request.args and minutes is None:
            raise ValueError("Invalid minutes")

        if minutes is not None and (minutes <= 0 or minutes != minutes):
            raise ValueError("minutes must be positive")

        if minutes is not None and (start or end):
            raise ValueError("Use minutes OR start/end")

        if minutes is not None:
            end_dt = now().replace(tzinfo=None)
            start_dt = end_dt - timedelta(minutes=minutes)
        else:
            start_dt = parse_date(start) if start else None
            end_dt = parse_date(end) if end else None

    except (ValueError, OverflowError) as exc:
        return jsonify(error=str(exc)), 400

    stmt = select(AssetRequest)

    if start_dt:
        stmt = stmt.where(AssetRequest.timestamp >= start_dt)
    if end_dt:
        stmt = stmt.where(AssetRequest.timestamp <= end_dt)
    if client_id is not None:
        stmt = stmt.where(AssetRequest.client_id == client_id)

    stmt = stmt.order_by(AssetRequest.timestamp.desc())

    with Session() as db:
        entries = db.scalars(stmt).all()
        return jsonify([serialize(e) for e in entries])


# GET /assets/<uuid>/like
@app.post("/assets/<asset_id>/like")
@authenticated
def like_asset(asset_id, username):
    asset_id = valid_uuid(asset_id)
    if not asset_id:
        return jsonify(error="Invalid UUID"), 400

    try:
        # Bulk update, supported by Immich.
        response = immich_request(
            "PUT",
            "/assets",
            json={
                "ids": [asset_id],
                "isFavorite": True,
            },
        )
    except requests.RequestException:
        app.logger.exception("Immich request failed")
        return jsonify(error="Immich unavailable"), 502

    if not response.ok:
        return jsonify(
            error="Immich request failed",
            status=response.status_code,
        ), 502

    return jsonify(ok=True, asset_id=asset_id, action="like")


# GET /assets/<uuid>/image
@app.get("/assets/<asset_id>/image")
@authenticated
def get_image(asset_id, username):
    asset_id = valid_uuid(asset_id)
    if not asset_id:
        return jsonify(error="Invalid UUID"), 400

    try:
        upstream = immich_request(
            "GET",
            f"/assets/{asset_id}/thumbnail",
            params={"size": "preview"},
            stream=True,
        )
    except requests.RequestException:
        app.logger.exception("Immich image request failed")
        return jsonify(error="Immich unavailable"), 502

    if not upstream.ok:
        status = upstream.status_code
        upstream.close()
        return jsonify(error="Immich image request failed"), status

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(generate()),
        content_type=upstream.headers.get(
            "Content-Type", "image/jpeg"
        ),
        headers={"Cache-Control": "private, no-store"},
    )


# GET /whoami
@app.get("/whoami")
@authenticated
def whoami(username):
    return jsonify(username=username)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)

