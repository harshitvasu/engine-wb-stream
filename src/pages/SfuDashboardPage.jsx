import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ArrowLeft, ExternalLink, RefreshCw, Activity, Server, Radio } from 'lucide-react';

export function SfuDashboardPage() {
  const [iframeKey, setIframeKey] = useState(0);

  const handleRefresh = () => {
    setIframeKey((prev) => prev + 1);
  };

  return (
    <div className="sfu-page-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#090d16', color: '#f3f4f6' }}>
      {/* Top Header Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 24px',
        background: '#111827',
        borderBottom: '1px solid #1f2937',
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <NavLink
            to="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              color: '#9ca3af',
              textDecoration: 'none',
              fontSize: '13px',
              padding: '6px 12px',
              borderRadius: '6px',
              background: '#1f2937',
              border: '1px solid #374151',
              transition: 'all 0.15s ease',
            }}
          >
            <ArrowLeft size={14} />
            <span>Lobby</span>
          </NavLink>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={18} className="text-sky-400" />
            <h1 style={{ fontSize: '16px', fontWeight: '600', color: '#ffffff', margin: 0 }}>
              WebRTC SFU Telemetry Dashboard
            </h1>
            <span style={{
              background: 'rgba(52, 211, 153, 0.15)',
              color: '#34d399',
              fontSize: '11px',
              fontWeight: '600',
              padding: '2px 8px',
              borderRadius: '9999px',
              border: '1px solid rgba(52, 211, 153, 0.3)',
            }}>
              Direct SFU Engine
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <NavLink
            to="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: '#1f2937',
              color: '#e5e7eb',
              border: '1px solid #374151',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              textDecoration: 'none',
            }}
            title="Browse active rooms and streams in Lobby"
          >
            <Radio size={13} style={{ color: '#34d399' }} />
            <span>Lobby Streams</span>
          </NavLink>

          <button
            type="button"
            onClick={handleRefresh}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: '#1f2937',
              color: '#e5e7eb',
              border: '1px solid #374151',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
            title="Reload dashboard frame"
          >
            <RefreshCw size={12} />
            <span>Reload Frame</span>
          </button>

          <a
            href="/sfu-dashboard"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: '#0284c7',
              color: '#ffffff',
              border: '1px solid #0369a1',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              textDecoration: 'none',
              fontWeight: '500',
            }}
            title="Open pure SFU dashboard in standalone browser tab"
          >
            <span>Open Standalone Tab</span>
            <ExternalLink size={12} />
          </a>
        </div>
      </div>

      {/* Embedded Direct SFU Dashboard Viewport */}
      <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <iframe
          key={iframeKey}
          src="/sfu/dashboard"
          title="WebRTC SFU Dashboard"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            background: '#090d16',
          }}
        />
      </div>
    </div>
  );
}
