import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { WritePage } from './pages/WritePage';
import { StreamPage } from './pages/StreamPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<WritePage />} />
        <Route path="/write" element={<WritePage />} />
        <Route path="/stream" element={<StreamPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
