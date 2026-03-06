const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Sessions directory
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory storage
const users = new Map(); // socketId -> { id, name, color, lat, lng, path: [{lat, lng, timestamp}], tracking: boolean }
const markers = new Map(); // markerId -> { id, lat, lng, label, createdBy, color, icon }

// Session management
let currentSession = null; // { id, name, createdAt, users: Map, markers: Map }
const userSessions = new Map(); // socketId -> sessionId

// Color palette for users
const colors = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b',
  '#2980b9', '#8e44ad', '#27ae60', '#d35400', '#2c3e50'
];
let colorIndex = 0;

// Available marker icons
const MARKER_ICONS = ['➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫️', '⚠️', '❌', '⭕️', '⛔️', '🚐', '🏠', '✅', '❎', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'];

// Path tracking settings
const MIN_DISTANCE_THRESHOLD = 5; // Minimum distance in meters to record a new point

// Track users by name within session for color reuse
const userNameColorMap = new Map(); // name -> color

function getNextColor() {
  const color = colors[colorIndex % colors.length];
  colorIndex++;
  return color;
}

// Calculate distance between two coordinates in meters (Haversine formula)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Session management functions
function createSession(name) {
  const session = {
    id: `session_${Date.now()}`,
    name: name,
    createdAt: new Date().toISOString(),
    users: new Map(),
    markers: new Map(),
    messages: [] // Store message history
  };
  currentSession = session;
  console.log(`Session created: ${session.name} (${session.id})`);
  return session;
}

function joinSession(socketId, user) {
  if (!currentSession) {
    createSession('Default Session');
  }
  userSessions.set(socketId, currentSession.id);
  currentSession.users.set(socketId, user);
  return currentSession;
}

function leaveSession(socketId) {
  userSessions.delete(socketId);
  if (currentSession) {
    currentSession.users.delete(socketId);
  }
}

function endSession() {
  if (!currentSession) return null;

  const session = currentSession;
  session.endedAt = new Date().toISOString();

  // Prepare session data for saving
  const sessionData = {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    users: [],
    markers: []
  };

  // Collect all user paths
  session.users.forEach((user, socketId) => {
    sessionData.users.push({
      name: user.name,
      color: user.color,
      path: user.path || [],
      totalPoints: user.path ? user.path.length : 0
    });
  });

  // Collect all markers
  markers.forEach((marker, markerId) => {
    sessionData.markers.push(marker);
  });

  // Generate filename
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
  const safeName = session.name.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
  const filename = `session_${dateStr}_${timeStr}_${safeName}.json`;
  const filepath = path.join(SESSIONS_DIR, filename);

  // Save to file
  fs.writeFileSync(filepath, JSON.stringify(sessionData, null, 2));
  console.log(`Session saved to: ${filename}`);

  // Reset session
  currentSession = null;
  markers.clear();
  users.clear();
  colorIndex = 0;

  return { sessionData, filename };
}

function getSavedSessions() {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions = files.map(filename => {
    try {
      const filepath = path.join(SESSIONS_DIR, filename);
      const content = fs.readFileSync(filepath, 'utf8');
      const data = JSON.parse(content);
      return {
        filename,
        name: data.name,
        createdAt: data.createdAt,
        endedAt: data.endedAt,
        userCount: data.users ? data.users.length : 0,
        markerCount: data.markers ? data.markers.length : 0
      };
    } catch (e) {
      return null;
    }
  }).filter(s => s !== null);
  return sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function loadSession(filename) {
  const filepath = path.join(SESSIONS_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// API endpoints
app.get('/api/sessions', (req, res) => {
  res.json(getSavedSessions());
});

app.get('/api/sessions/:filename', (req, res) => {
  const session = loadSession(req.params.filename);
  if (session) {
    res.json(session);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.delete('/api/sessions/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(SESSIONS_DIR, filename);
  
  // Security check - only allow .json files
  if (!filename.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid file type' });
  }
  
  // Check if file exists
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    fs.unlinkSync(filepath);
    console.log(`Session deleted: ${filename}`);
    res.json({ success: true, message: 'Session deleted' });
  } catch (err) {
    console.error(`Error deleting session ${filename}:`, err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

app.get('/api/current-session', (req, res) => {
  if (currentSession) {
    res.json({
      active: true,
      name: currentSession.name,
      userCount: currentSession.users.size,
      createdAt: currentSession.createdAt
    });
  } else {
    res.json({ active: false });
  }
});

function broadcastUsers() {
  const usersList = Array.from(users.values());
  io.emit('users:update', usersList);
}

function broadcastMarkers() {
  const markersList = Array.from(markers.values());
  io.emit('markers:update', markersList);
}

function broadcastIcons() {
  io.emit('icons:list', MARKER_ICONS);
}

function broadcastSessionInfo() {
  if (currentSession) {
    io.emit('session:info', {
      id: currentSession.id,
      name: currentSession.name,
      createdAt: currentSession.createdAt,
      userCount: currentSession.users.size
    });
  } else {
    io.emit('session:info', null);
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send existing markers and icons to new user
  socket.emit('markers:init', Array.from(markers.values()));
  socket.emit('icons:list', MARKER_ICONS);

  // Send current session info if exists
  if (currentSession) {
    socket.emit('session:info', {
      id: currentSession.id,
      name: currentSession.name,
      createdAt: currentSession.createdAt,
      userCount: currentSession.users.size
    });
  }

  // Handle session creation
  socket.on('session:create', (sessionName) => {
    // End current session if exists
    if (currentSession) {
      endSession();
      io.emit('session:ended');
    }
    createSession(sessionName || 'New Session');
    broadcastSessionInfo();
    socket.emit('session:created', currentSession);
  });

  // Handle session join (get active session info)
  socket.on('session:getActive', () => {
    if (currentSession) {
      socket.emit('session:active', {
        id: currentSession.id,
        name: currentSession.name,
        createdAt: currentSession.createdAt,
        userCount: currentSession.users.size
      });
    } else {
      socket.emit('session:active', null);
    }
  });

  // Handle session end
  socket.on('session:end', () => {
    if (currentSession) {
      const result = endSession();
      io.emit('session:ended', result);
      io.emit('markers:update', []);
      io.emit('users:update', []);
    }
  });

  // Handle user joining
  socket.on('user:join', (data) => {
    // Check if user with same name already exists in this session
    let userColor;
    let previousPath = [];

    if (userNameColorMap.has(data.name)) {
      // Reuse existing color for this username
      userColor = userNameColorMap.get(data.name);
      console.log(`Reusing color ${userColor} for returning user: ${data.name}`);

      // Find previous user data with same name to get their path
      if (currentSession && currentSession.users) {
        for (const [sid, u] of currentSession.users) {
          if (u.name === data.name && u.path) {
            previousPath = [...u.path];
            console.log(`Restoring ${previousPath.length} path points for: ${data.name}`);
            break;
          }
        }
      }
    } else {
      // Assign new color
      userColor = getNextColor();
      userNameColorMap.set(data.name, userColor);
    }

    const user = {
      id: socket.id,
      name: data.name,
      color: userColor,
      lat: data.lat,
      lng: data.lng,
      path: previousPath.length > 0 ? previousPath :
        (data.lat && data.lng ? [{ lat: data.lat, lng: data.lng, timestamp: Date.now() }] : []),
      tracking: true // Auto-start tracking
    };
    users.set(socket.id, user);

    // Join session
    joinSession(socket.id, user);

    console.log(`User joined: ${user.name} (${user.color}) with ${user.path.length} path points`);

    // Send user their assigned info with full path history
    socket.emit('user:assigned', {
      id: user.id,
      color: user.color,
      tracking: user.tracking,
      path: user.path
    });

    // Send message history to the new user
    if (currentSession && currentSession.messages && currentSession.messages.length > 0) {
      socket.emit('message:history', currentSession.messages);
      console.log(`Sent ${currentSession.messages.length} message(s) history to: ${user.name}`);
    }

    // Broadcast updated user list and session info
    broadcastUsers();
    broadcastSessionInfo();
  });

  // Handle position updates
  socket.on('user:position', (position) => {
    const user = users.get(socket.id);
    if (user) {
      const oldLat = user.lat;
      const oldLng = user.lng;

      user.lat = position.lat;
      user.lng = position.lng;

      // Add to path if tracking is enabled and position is valid and moved enough
      if (user.tracking && position.lat && position.lng) {
        const shouldRecord = !oldLat || !oldLng ||
          calculateDistance(oldLat, oldLng, position.lat, position.lng) >= MIN_DISTANCE_THRESHOLD;

        if (shouldRecord) {
          user.path.push({
            lat: position.lat,
            lng: position.lng,
            timestamp: Date.now()
          });
          // No path limit - keep all points until session ends
        }
      }

      broadcastUsers();
    }
  });

  // Handle tracking toggle
  socket.on('user:toggleTracking', () => {
    const user = users.get(socket.id);
    if (user) {
      user.tracking = !user.tracking;
      socket.emit('user:trackingChanged', user.tracking);
      broadcastUsers();
      console.log(`Tracking ${user.tracking ? 'started' : 'stopped'} for: ${user.name}`);
    }
  });

  // Handle adding markers
  socket.on('marker:add', (data) => {
    const user = users.get(socket.id);
    if (user) {
      const marker = {
        id: `marker_${Date.now()}_${socket.id}`,
        lat: data.lat,
        lng: data.lng,
        label: data.label || '',
        createdBy: user.name,
        color: user.color,
        icon: data.icon || '📍',
        photo: data.photo || null,
        createdAt: Date.now()
      };
      markers.set(marker.id, marker);
      
      // Store in current session
      if (currentSession) {
        currentSession.markers.set(marker.id, marker);
      }
      
      io.emit('marker:added', marker);
      console.log(`Marker added by ${user.name} at (${data.lat}, ${data.lng})${data.photo ? ' with photo' : ''}`);
    }
  });

  // Handle removing markers
  socket.on('marker:remove', (markerId) => {
    if (markers.has(markerId)) {
      markers.delete(markerId);
      io.emit('marker:removed', markerId);
    }
  });

  // Handle path clearing
  socket.on('user:clearPath', () => {
    const user = users.get(socket.id);
    if (user) {
      user.path = user.lat && user.lng ? [{ lat: user.lat, lng: user.lng, timestamp: Date.now() }] : [];
      broadcastUsers();
      console.log(`Path cleared for: ${user.name}`);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
    console.log(`User disconnected: ${user.name}`);
    users.delete(socket.id);
    leaveSession(socket.id);
    broadcastUsers();
    broadcastSessionInfo();
    }
  });

  // Handle message add
  socket.on('message:add', (message) => {
    const user = users.get(socket.id);
    if (user && currentSession) {
    const msg = {
      id: message.id || `msg_${Date.now()}`,
      text: message.text,
      author: user.name,
      color: user.color,
      timestamp: Date.now()
    };
    // Store message in session history
    currentSession.messages.push(msg);
    io.emit('message:new', msg);
  }
  });

  // Handle message request
  socket.on('message:getHistory', () => {
    // Return message history (if stored)
    socket.emit('message:history', []);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
});
