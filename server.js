const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); // Increase limit for large photo uploads (iPhone photos can be 10-30MB)

// Sessions directory
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'photos');
const ACTIVE_SESSION_FILE = path.join(__dirname, 'active-session.json');

// Ensure directories exist
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// API to upload photo
app.post('/api/upload-photo', async (req, res) => {
  console.log('=== Photo Upload Request ===');
  console.log('Photo length:', req.body.photo ? req.body.photo.length : 'undefined');

  try {
    const { photo } = req.body;

    if (!photo) {
      console.error('❌ No photo provided');
      return res.status(400).json({ error: 'No photo provided' });
    }

    // Extract base64 data
    const matches = photo.match(/^data:image\/(png|jpeg|jpg|heic|webp);base64,(.+)$/);
    if (!matches) {
      console.error('❌ Invalid photo format, starts with:', photo.substring(0, 50));
      return res.status(400).json({ error: 'Invalid photo format' });
    }

    const imageData = matches[2];
    const originalBuffer = Buffer.from(imageData, 'base64');

    console.log(`Original photo size: ${Math.round(originalBuffer.length / 1024)}KB`);

    // Generate unique filename
    const filename = `photo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // Compress and convert to JPG using sharp
    const compressedBuffer = await sharp(originalBuffer)
      .resize(1920, 1920, { // Max dimensions
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality: 85, // Good quality compression
        progressive: true,
        mozjpeg: true // Better compression
      })
      .toBuffer();

    // Save compressed photo
    fs.writeFileSync(filepath, compressedBuffer);

    // Return URL
    const photoUrl = `/uploads/photos/${filename}`;
    const savedSize = Math.round(compressedBuffer.length / 1024);
    const compressionRatio = ((1 - compressedBuffer.length / originalBuffer.length) * 100).toFixed(1);

    console.log(`✅ Photo uploaded: ${filename}`);
    console.log(`   Original: ${Math.round(originalBuffer.length / 1024)}KB`);
    console.log(`   Compressed: ${savedSize}KB`);
    console.log(`   Saved: ${compressionRatio}%`);

    res.json({ url: photoUrl, size: savedSize });
  } catch (error) {
    console.error('❌ Error uploading photo:', error);
    res.status(500).json({ error: 'Failed to upload photo', details: error.message });
  }
});

// In-memory storage
const users = new Map(); // socketId -> { id, name, color, lat, lng, path: [{lat, lng, timestamp}], tracking: boolean }
const markers = new Map(); // markerId -> { id, lat, lng, label, createdBy, color, icon }

// Session management - Multiple sessions in parallel
const sessions = new Map(); // sessionId -> { id, name, createdAt, users: Map, markers: Map, messages: [] }
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

// Store user history for session persistence (survives disconnects)
const userHistory = new Map(); // name -> { color, path, tracking }

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
function saveSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found:', sessionId);
    return;
  }

  try {
    const sessionData = {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      users: Array.from(session.users.entries()).map(([socketId, user]) => ({
        name: user.name,
        color: user.color,
        path: user.path || [],
        tracking: user.tracking !== undefined ? user.tracking : true
      })),
      markers: Array.from(session.markers.values()),
      messages: session.messages || []
    };

    const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
    fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
    console.log(`Session saved: ${session.name} (${sessionId})`);
  } catch (err) {
    console.error(`Error saving session ${sessionId}:`, err);
  }
}

function saveAllSessions() {
  try {
    sessions.forEach((session, sessionId) => {
      saveSession(sessionId);
    });
    console.log(`Saved ${sessions.size} sessions`);
  } catch (err) {
    console.error('Error saving all sessions:', err);
  }
}

function loadAllSessions() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      console.log('Sessions directory does not exist');
      return;
    }

    const files = fs.readdirSync(SESSIONS_DIR).filter(f =>
      f.endsWith('.json') &&
      !f.includes('session_2026') && // Skip archived sessions
      !f.includes('session_2025') &&
      !f.includes('session_2024')
    );

    sessions.clear();
    let loaded = 0;

    files.forEach(file => {
      try {
        const filepath = path.join(SESSIONS_DIR, file);
        const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));

        // Skip ended sessions
        if (data.endedAt) {
          return;
        }

        // Restore session
        const session = {
          id: data.id,
          name: data.name,
          createdAt: data.createdAt,
          users: new Map(),
          markers: new Map(),
          messages: data.messages || []
        };

        // Restore users to userHistory (they will reconnect with new socket IDs)
        if (data.users) {
          data.users.forEach(u => {
            userHistory.set(u.name, {
              color: u.color,
              path: u.path || [],
              tracking: u.tracking !== undefined ? u.tracking : true
            });
            userNameColorMap.set(u.name, u.color);
          });
        }

        // Restore markers
        if (data.markers) {
          data.markers.forEach(marker => {
            session.markers.set(marker.id, marker);
          });
        }

        sessions.set(session.id, session);
        loaded++;
        console.log(`Session restored: ${session.name} (${session.markers.size} markers, ${data.users ? data.users.length : 0} users in history)`);
      } catch (err) {
        console.error(`Error loading session ${file}:`, err);
      }
    });

    console.log(`Loaded ${loaded} active sessions`);
  } catch (err) {
    console.error('Error loading sessions:', err);
  }
}

function createSession(name) {
  const session = {
    id: `session_${Date.now()}`,
    name: name,
    createdAt: new Date().toISOString(),
    users: new Map(),
    markers: new Map(),
    messages: [] // Store message history
  };
  sessions.set(session.id, session);
  console.log(`Session created: ${session.name} (${session.id})`);

  // Save all active sessions to file
  saveAllSessions();

  return session;
}

function joinSession(socketId, user, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`Session not found: ${sessionId}`);
    return null;
  }

  userSessions.set(socketId, sessionId);
  session.users.set(socketId, user);
  saveSession(sessionId);
  return session;
}

function leaveSession(socketId) {
  const sessionId = userSessions.get(socketId);
  if (!sessionId) return;

  const session = sessions.get(sessionId);
  if (session) {
    const user = session.users.get(socketId);
    if (user) {
      // Save user data to history before removing
      userHistory.set(user.name, {
        color: user.color,
        path: user.path || [],
        tracking: user.tracking !== undefined ? user.tracking : true
      });
    }
    session.users.delete(socketId);
  }

  userSessions.delete(socketId);
}

function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

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
  session.users.forEach((user) => {
    sessionData.users.push({
      name: user.name,
      color: user.color,
      path: user.path || [],
      totalPoints: user.path ? user.path.length : 0
    });
  });

  // Collect all markers
  session.markers.forEach((marker) => {
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

  // Delete session file
  const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      console.log(`Session file deleted: ${sessionId}`);
    }
  } catch (err) {
    console.error('Error deleting session file:', err);
  }

  // Remove session from memory
  sessions.delete(sessionId);

  // Remove all users from this session
  userSessions.forEach((sid, socketId) => {
    if (sid === sessionId) {
      userSessions.delete(socketId);
    }
  });

  return { sessionData, filename, sessionId };
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
// Get all active sessions (from memory)
app.get('/api/sessions', (req, res) => {
  const activeSessions = Array.from(sessions.values()).map(s => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    userCount: s.users.size,
    markerCount: s.markers.size
  }));
  res.json(activeSessions);
});

// Get all past sessions (from files)
app.get('/api/sessions/past', (req, res) => {
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
  // For backward compatibility, return first active session or null
  const firstSession = sessions.values().next().value || null;

  if (firstSession) {
    res.json({
      active: true,
      name: firstSession.name,
      userCount: firstSession.users.size,
      createdAt: firstSession.createdAt
    });
  } else {
    res.json({ active: false });
  }
});

function broadcastUsers(sessionId) {
  if (!sessionId) {
    console.error('broadcastUsers called without sessionId');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found for broadcastUsers:', sessionId);
    return;
  }

  // Only broadcast users in this specific session
  const usersList = Array.from(session.users.values());

  // Only send to users in this session
  session.users.forEach((user, socketId) => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('users:update', usersList);
    }
  });
}

function broadcastMarkers(sessionId) {
  if (!sessionId) {
    console.error('broadcastMarkers called without sessionId');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found for broadcastMarkers:', sessionId);
    return;
  }

  // Only broadcast markers in this specific session
  const markersList = Array.from(session.markers.values());

  // Only send to users in this session
  session.users.forEach((user, socketId) => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('markers:update', markersList);
    }
  });
}

function broadcastIcons() {
  io.emit('icons:list', MARKER_ICONS);
}

function broadcastSessionInfo() {
  const sessionsList = Array.from(sessions.values()).map(s => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    userCount: s.users.size
  }));
  io.emit('sessions:list', sessionsList);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send existing markers and icons to new user
  socket.emit('markers:init', Array.from(markers.values()));
  socket.emit('icons:list', MARKER_ICONS);

  // Send active sessions list
  broadcastSessionInfo();

  // Handle session creation
  socket.on('session:create', (sessionName) => {
    const session = createSession(sessionName || 'New Session');
    broadcastSessionInfo();
    socket.emit('session:created', {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt
    });
  });

  // Handle session join
  socket.on('session:join', (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return socket.emit('error', { message: 'Session not found' });
    }

    const user = users.get(socket.id);
    if (!user) {
      return socket.emit('error', { message: 'User not registered' });
    }

    joinSession(socket.id, user, sessionId);

    socket.emit('session:joined', {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt
    });

    // Send current users and markers
    const usersList = Array.from(session.users.values());
    const markersList = Array.from(session.markers.values());
    socket.emit('users:update', usersList);
    socket.emit('markers:update', markersList);

    // Send message history
    if (session.messages && session.messages.length > 0) {
      socket.emit('message:history', session.messages);
    }

    broadcastSessionInfo();
  });

  // Handle session getActive (backward compatibility)
  socket.on('session:getActive', () => {
    broadcastSessionInfo();
  });

  // Handle session end
  socket.on('session:end', (sessionId) => {
    const result = endSession(sessionId);
    if (result) {
      io.emit('session:ended', result);
    }
  });

  // Handle user joining
  socket.on('user:join', (data) => {
    // Check if user with same name already exists in this session
    let userColor;
    let previousPath = [];
    let userTracking = true;

    if (userHistory.has(data.name)) {
      // Restore user data from history (survives disconnects)
      const history = userHistory.get(data.name);
      userColor = history.color;
      previousPath = history.path || [];
      userTracking = history.tracking !== undefined ? history.tracking : true;
      console.log(`Restoring user: ${data.name} (${userColor}) with ${previousPath.length} path points`);
    } else if (userNameColorMap.has(data.name)) {
      // Fallback: reuse color from userNameColorMap
      userColor = userNameColorMap.get(data.name);
      console.log(`Reusing color ${userColor} for returning user: ${data.name}`);
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
      tracking: userTracking
    };
    users.set(socket.id, user);

    // Auto-join first available session or create default
    let sessionId = sessions.size > 0 ? sessions.keys().next().value : null;

    if (!sessionId) {
      const defaultSession = createSession('Default Session');
      sessionId = defaultSession.id;
    }

    joinSession(socket.id, user, sessionId);

    console.log(`User joined: ${user.name} (${user.color}) with ${user.path.length} path points`);

    // Send user their assigned info with full path history
    socket.emit('user:assigned', {
      id: user.id,
      color: user.color,
      tracking: user.tracking,
      path: user.path
    });

    // Send message history to the new user
    const session = sessions.get(sessionId);
    if (session && session.messages && session.messages.length > 0) {
      socket.emit('message:history', session.messages);
      console.log(`Sent ${session.messages.length} message(s) history to: ${user.name}`);
    }

    // Broadcast updated user list and session info (session-specific)
    broadcastUsers(sessionId);
    broadcastSessionInfo();
  });

  // Handle position updates
  socket.on('user:position', (position) => {
    const user = users.get(socket.id);
    const sessionId = userSessions.get(socket.id);

    if (user && sessionId) {
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

      broadcastUsers(sessionId);
    }
  });

  // Handle tracking toggle
  socket.on('user:toggleTracking', () => {
    const user = users.get(socket.id);
    const sessionId = userSessions.get(socket.id);

    if (user && sessionId) {
      user.tracking = !user.tracking;
      socket.emit('user:trackingChanged', user.tracking);
      broadcastUsers(sessionId);
      console.log(`Tracking ${user.tracking ? 'started' : 'stopped'} for: ${user.name}`);
    }
  });

  // Handle adding markers
  socket.on('marker:add', (data) => {
    const user = users.get(socket.id);
    const sessionId = userSessions.get(socket.id);
    const session = sessions.get(sessionId);

    if (user && session) {
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
      session.markers.set(marker.id, marker);
      saveSession(sessionId);

      // Broadcast to users in this session only
      broadcastMarkers(sessionId);
      console.log(`Marker added by ${user.name} at (${data.lat}, ${data.lng})${data.photo ? ' with photo' : ''}`);
    }
  });

  // Handle removing markers
  socket.on('marker:remove', (markerId) => {
    const sessionId = userSessions.get(socket.id);
    const session = sessions.get(sessionId);

    if (session && session.markers.has(markerId)) {
      session.markers.delete(markerId);
      markers.delete(markerId);
      saveSession(sessionId);

      // Broadcast to users in this session only
      broadcastMarkers(sessionId);
    }
  });

  // Handle path clearing
  socket.on('user:clearPath', () => {
    const user = users.get(socket.id);
    const sessionId = userSessions.get(socket.id);

    if (user && sessionId) {
      user.path = user.lat && user.lng ? [{ lat: user.lat, lng: user.lng, timestamp: Date.now() }] : [];
      broadcastUsers(sessionId);
      console.log(`Path cleared for: ${user.name}`);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    const sessionId = userSessions.get(socket.id);

    if (user) {
      console.log(`User disconnected: ${user.name}`);
      users.delete(socket.id);
      leaveSession(socket.id);

      // Only broadcast to users in the same session
      if (sessionId) {
        broadcastUsers(sessionId);
      }

      broadcastSessionInfo();
    }
  });

  // Handle message add
  socket.on('message:add', (message) => {
    const user = users.get(socket.id);
    const sessionId = userSessions.get(socket.id);
    const session = sessions.get(sessionId);

    if (user && session) {
      const msg = {
        id: message.id || `msg_${Date.now()}`,
        text: message.text,
        author: user.name,
        color: user.color,
        timestamp: Date.now()
      };
      // Store message in session history
      session.messages.push(msg);
      saveSession(sessionId);
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

  // Load all active sessions on server start
  loadAllSessions();

  // Save all sessions every 30 seconds
  setInterval(() => {
    if (sessions.size > 0) {
      saveAllSessions();
    }
  }, 30000);

  console.log(`Multi-session server ready (${sessions.size} sessions loaded)`);
});
