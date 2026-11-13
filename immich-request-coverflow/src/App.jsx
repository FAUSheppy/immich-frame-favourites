import { useCallback, useEffect, useRef, useState } from 'react';

const REFRESH_MS = 60_000;
const REQUEST_MINUTES = 2 * 24 * 60;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Unauthorized. Sign in through the authentication proxy.');
    throw new Error(`Request failed (HTTP ${response.status})`);
  }
  return response;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function Icon({ name, size = 20 }) {
  if (name === 'heart') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" />
    </svg>
  );
  if (name === 'chevron') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
  if (name === 'refresh') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.6-4.5L3 9m0-6v6h6M4 13a8 8 0 0 0 14.6 4.5L21 15m0 6v-6h-6" />
    </svg>
  );
  return null;
}

function Photo({ item, active }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.RequestedAssetId]);

  return (
    <div className="photo-frame">
      {failed ? (
        <div className="image-error">Preview unavailable</div>
      ) : (
        <img
          src={`/assets/${encodeURIComponent(item.RequestedAssetId)}/image`}
          alt={`Photo requested ${formatTime(item.DateTime)}`}
          draggable="false"
          loading={active ? 'eager' : 'lazy'}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

export default function App() {
  const [username, setUsername] = useState('');
  const [items, setItems] = useState([]);
  const [current, setCurrent] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [liking, setLiking] = useState(false);
  const [liked, setLiked] = useState({});
  const currentIdRef = useRef(null);
  const touchStartRef = useRef(null);
  const lastLoadedRef = useRef([]);

  const selected = items[current] ?? null;
  currentIdRef.current = selected?.id ?? null;

  const load = useCallback(async ({ initial = false } = {}) => {
    try {
      const params = new URLSearchParams({ minutes: String(REQUEST_MINUTES) });
      const clientId = new URLSearchParams(window.location.search).get('client_id');
      if (clientId !== null) params.set('client_id', clientId);

      const [whoamiResponse, requestsResponse] = await Promise.all([
        api('/whoami'),
        api(`/requests?${params}`),
      ]);
      const [user, requests] = await Promise.all([
        whoamiResponse.json(),
        requestsResponse.json(),
      ]);
      if (!Array.isArray(requests)) throw new Error('Unexpected response format');

      // Oldest on left, newest on right. Keep viewing the same request during refresh.
      const next = [...requests].sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime) || a.id - b.id);
      const previousIds = new Set(lastLoadedRef.current.map((item) => item.id));
      const previousSelectedId = currentIdRef.current;
      const firstLoad = lastLoadedRef.current.length === 0;
      const wasNewest = lastLoadedRef.current.length > 0 &&
        previousSelectedId === lastLoadedRef.current.at(-1)?.id;
      const hasNew = next.some((item) => !previousIds.has(item.id));

      setItems(next);
      setCurrent(() => {
        if (!next.length) return -1;
        if (initial || firstLoad || (wasNewest && hasNew)) return next.length - 1;
        const priorIndex = next.findIndex((item) => item.id === previousSelectedId);
        return priorIndex >= 0 ? priorIndex : next.length - 1;
      });
      lastLoadedRef.current = next;
      setUsername(user.username || 'Unknown user');
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to load requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load({ initial: true });
    const timer = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const move = useCallback((delta) => {
    setCurrent((index) => Math.max(0, Math.min(items.length - 1, index + delta)));
  }, [items.length]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, textarea, button')) return;
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move]);

  const like = async () => {
    if (!selected || liking) return;
    const assetId = selected.RequestedAssetId;
    setLiking(true);
    try {
      await api(`/assets/${encodeURIComponent(assetId)}/like`, { method: 'POST' });
      setLiked((previous) => ({ ...previous, [assetId]: true }));
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to favourite photo');
    } finally {
      setLiking(false);
    }
  };

  function handleTouchStart(event) {
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event) {
    if (!touchStartRef.current) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) move(dx < 0 ? 1 : -1);
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand"><span className="brand-mark" />Photo requests</div>
        <div className="header-right">
          <button className="icon-button refresh" title="Refresh requests" aria-label="Refresh requests" onClick={() => load()}>
            <Icon name="refresh" size={18} />
          </button>
          <div className="user-pill"><span className="user-indicator" />{username || '…'}</div>
        </div>
      </header>

      <main className="main">
        <div className="intro">
          <span className="eyebrow">PHOTO REQUESTS</span>
          <h1>Moments worth keeping.</h1>
          <p>Browse requested photos and save the ones you love.</p>
        </div>

        {error && <div className="alert" role="alert">{error}</div>}

        {loading ? (
          <div className="status">Loading photos…</div>
        ) : !items.length ? (
          <div className="empty">
            <div className="empty-symbol">▧</div>
            <h2>No requests yet</h2>
            <p>New photo requests will appear here automatically.</p>
            <button className="secondary-button" onClick={() => load()}>Refresh</button>
          </div>
        ) : (
          <section className="gallery" aria-label="Photo carousel">
            <div className="date-group">
              <div className="date-label">REQUESTED ON</div>
              <div className="date-value" key={selected?.id}>{formatTime(selected?.DateTime)}</div>
            </div>

            <div className="carousel-shell">
              <button
                className="nav-arrow nav-prev"
                aria-label="Previous photo"
                onClick={() => move(-1)}
                disabled={current === 0}
              >
                <Icon name="chevron" size={25} />
              </button>

              <div className="carousel" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
                <div className="carousel-stage">
                  {items.map((item, index) => {
                    const offset = index - current;
                    if (Math.abs(offset) > 3) return null;
                    return (
                      <div
                        className={`slide ${offset === 0 ? 'active' : ''}`}
                        key={item.id}
                        style={{
                          '--offset': offset,
                          '--abs': Math.abs(offset),
                          zIndex: 20 - Math.abs(offset),
                        }}
                        aria-hidden={offset !== 0}
                        onClick={() => offset !== 0 && setCurrent(index)}
                      >
                        <Photo item={item} active={offset === 0} />
                      </div>
                    );
                  })}
                </div>
              </div>

              <button
                className="nav-arrow nav-next"
                aria-label="Next photo"
                onClick={() => move(1)}
                disabled={current === items.length - 1}
              >
                <Icon name="chevron" size={25} />
              </button>
            </div>

            <div className="photo-actions">
              <button
                className={`like-button ${liked[selected?.RequestedAssetId] ? 'liked' : ''}`}
                onClick={like}
                disabled={liking || liked[selected?.RequestedAssetId]}
              >
                <Icon name="heart" size={19} />
                {liking ? 'Saving…' : liked[selected?.RequestedAssetId] ? 'Added to favourites' : 'Add to favourites'}
              </button>
              <div className="counter" aria-live="polite">{current + 1} <span>/ {items.length}</span></div>
            </div>
            <div className="swipe-hint">Swipe to explore older requests</div>
          </section>
        )}
      </main>
    </div>
  );
}
