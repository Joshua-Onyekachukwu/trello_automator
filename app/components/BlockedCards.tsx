'use client';

import { useState } from 'react';

interface BlockedCard {
  cardId: string;
  cardName: string;
}

export default function BlockedCards({ initialCards }: { initialCards: BlockedCard[] }) {
  const [cards, setCards] = useState(initialCards);
  const [cardId, setCardId] = useState('');
  const [cardName, setCardName] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!cardId.trim() || !token.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/trello/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: cardId.trim(), cardName: cardName.trim(), token }),
      });
      if (!res.ok) {
        setError('Unauthorized — check your token');
        setLoading(false);
        return;
      }
      setCards([{ cardId: cardId.trim(), cardName: cardName.trim() }, ...cards]);
      setCardId('');
      setCardName('');
    } catch {
      setError('Failed to add card');
    }
    setLoading(false);
  }

  async function handleRemove(cardId: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/trello/blocked', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, token }),
      });
      if (!res.ok) {
        setError('Unauthorized — check your token');
        setLoading(false);
        return;
      }
      setCards(cards.filter((c) => c.cardId !== cardId));
    } catch {
      setError('Failed to remove card');
    }
    setLoading(false);
  }

  const input: React.CSSProperties = { padding: '4px 8px', marginRight: 8 };
  const button: React.CSSProperties = { padding: '4px 14px' };

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #e0e0e0' }}>
      <div style={{ marginBottom: 6, color: '#333', fontSize: 14, fontWeight: 600 }}>
        🚫 Blocked Cards
      </div>
      <p style={{ margin: '0 0 12px', color: '#777', fontSize: 12 }}>
        Cards below will never be claimed by the automation. Add a card ID to block it.
      </p>

      {cards.length > 0 && (
        <ul style={{ margin: '0 0 12px', padding: '0 0 0 16px' }}>
          {cards.map((c) => (
            <li key={c.cardId} style={{ fontSize: 12, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>{c.cardId}</span>
              {c.cardName && <span style={{ color: '#555' }}>({c.cardName})</span>}
              <button
                onClick={() => handleRemove(c.cardId)}
                disabled={loading || !token}
                style={{ fontSize: 11, color: '#c62828', background: 'none', border: 'none', cursor: token ? 'pointer' : 'default', textDecoration: 'underline', opacity: token ? 1 : 0.4 }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {cards.length === 0 && (
        <p style={{ margin: '0 0 12px', color: '#888', fontSize: 12 }}>No cards blocked.</p>
      )}

      {error && (
        <p style={{ margin: '0 0 8px', color: '#c62828', fontSize: 12 }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Card ID"
          value={cardId}
          onChange={(e) => setCardId(e.target.value)}
          required
          style={{ ...input, width: 260, margin: 0 }}
        />
        <input
          type="text"
          placeholder="Name (optional)"
          value={cardName}
          onChange={(e) => setCardName(e.target.value)}
          style={{ ...input, width: 160, margin: 0 }}
        />
        <input
          type="password"
          placeholder="Admin token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          style={{ ...input, width: 140, margin: 0 }}
        />
        <button onClick={handleAdd} disabled={loading || !cardId.trim() || !token.trim()} style={button}>
          Block
        </button>
      </div>
      <p style={{ margin: '8px 0 0', color: '#888', fontSize: 11 }}>
        Enter your admin token once — it stays in your browser only.
      </p>
    </div>
  );
}
