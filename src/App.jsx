import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LobbyPage } from './pages/LobbyPage';
import { WritePage } from './pages/WritePage';
import { StreamPage } from './pages/StreamPage';
import { SfuDashboardPage } from './pages/SfuDashboardPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LobbyPage />} />
        <Route path="/write/:roomId" element={<WritePage />} />
        <Route path="/write" element={<LobbyPage />} />
        <Route path="/stream/:roomId" element={<StreamPage />} />
        <Route path="/stream" element={<StreamPage />} />
        <Route path="/sfu-dashboard" element={<SfuDashboardPage />} />
        <Route path="/dashboard" element={<SfuDashboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
