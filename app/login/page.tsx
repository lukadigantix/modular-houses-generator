'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import Image from 'next/image';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError('Pogrešan email ili lozinka.');
    } else {
      window.location.href = '/';
    }
    setLoading(false);
  };

  return (
    <>
    <style>{`
      .login-input::placeholder { color: rgba(255,255,255,0.18); }
    `}</style>
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    }}>
      <div style={{ width: '100%', maxWidth: 380, padding: '0 24px' }}>

        {/* Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 48 }}>
          <Image
            src="/modular-dark.png"
            alt="Modular Houses"
            width={320}
            height={96}
            style={{ height: 85, width: 'auto', filter: 'brightness(0) invert(1)' }}
            priority
          />
        </div>

        {/* Card */}
        <div style={{
          background: '#141414',
          border: '1px solid #222',
          borderRadius: 16,
          padding: '40px 36px',
        }}>
          <h1 style={{
            color: '#ffffff',
            fontSize: 20,
            fontWeight: 600,
            marginBottom: 8,
            letterSpacing: '-0.02em',
          }}>Prijava</h1>
          <p style={{ color: '#555', fontSize: 13, marginBottom: 32 }}>
            Unesite vaše kredencijale za pristup
          </p>

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ color: '#888', fontSize: 12, fontWeight: 500, letterSpacing: '0.04em' }}>
                EMAIL
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="ime@kompanija.rs"
                className="login-input"
                style={{
                  background: '#1a1a1a',
                  border: '1px solid #2a2a2a',
                  borderRadius: 8,
                  padding: '11px 14px',
                  color: '#ffffff',
                  fontSize: 14,
                  outline: 'none',
                  transition: 'border-color 0.15s',
                } as React.CSSProperties}
                onFocus={e => e.target.style.borderColor = '#444'}
                onBlur={e => e.target.style.borderColor = '#2a2a2a'}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ color: '#888', fontSize: 12, fontWeight: 500, letterSpacing: '0.04em' }}>
                LOZINKA
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="login-input"
                style={{
                  background: '#1a1a1a',
                  border: '1px solid #2a2a2a',
                  borderRadius: 8,
                  padding: '11px 14px',
                  color: '#ffffff',
                  fontSize: 14,
                  outline: 'none',
                  transition: 'border-color 0.15s',
                } as React.CSSProperties}
                onFocus={e => e.target.style.borderColor = '#444'}
                onBlur={e => e.target.style.borderColor = '#2a2a2a'}
              />
            </div>

            {error && (
              <p style={{
                color: '#ff4444',
                fontSize: 13,
                background: '#1a0a0a',
                border: '1px solid #3a1a1a',
                borderRadius: 8,
                padding: '10px 14px',
                margin: 0,
              }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: 8,
                background: loading ? '#222' : '#ffffff',
                color: loading ? '#555' : '#0a0a0a',
                border: 'none',
                borderRadius: 8,
                padding: '12px',
                fontSize: 14,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s, color 0.15s',
                letterSpacing: '0.01em',
              }}
            >
              {loading ? 'Prijavljivanje...' : 'Prijavi se'}
            </button>
          </form>
        </div>

        <p style={{ color: '#333', fontSize: 12, textAlign: 'center', marginTop: 32 }}>
          © {new Date().getFullYear()} Modular Houses d.o.o.
        </p>
      </div>
    </div>
    </>
  );
}
