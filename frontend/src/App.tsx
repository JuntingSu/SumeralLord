import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './stores/auth';
import Login from './pages/Login';
import Register from './pages/Register';
import Lobby from './pages/Lobby';
import CreateRoom from './pages/CreateRoom';
import Maps from './pages/Maps';
import Room from './pages/Room';
import Game from './pages/Game';
import Replay from './pages/Replay';
import History from './pages/History';
import Leaderboard from './pages/Leaderboard';

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Home() {
  const token = useAuth((s) => s.token);
  return <Navigate to={token ? '/lobby' : '/login'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/lobby"
        element={
          <RequireAuth>
            <Lobby />
          </RequireAuth>
        }
      />
      <Route
        path="/create-room"
        element={
          <RequireAuth>
            <CreateRoom />
          </RequireAuth>
        }
      />
      <Route
        path="/maps"
        element={
          <RequireAuth>
            <Maps />
          </RequireAuth>
        }
      />
      <Route
        path="/room/:roomId"
        element={
          <RequireAuth>
            <Room />
          </RequireAuth>
        }
      />
      <Route
        path="/game/:roomId"
        element={
          <RequireAuth>
            <Game />
          </RequireAuth>
        }
      />
      <Route
        path="/replay/:gameId"
        element={
          <RequireAuth>
            <Replay />
          </RequireAuth>
        }
      />
      <Route
        path="/history"
        element={
          <RequireAuth>
            <History />
          </RequireAuth>
        }
      />
      <Route
        path="/leaderboard"
        element={
          <RequireAuth>
            <Leaderboard />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
