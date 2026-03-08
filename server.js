const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Directories
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const ENDED_DIR = path.join(SESSIONS_DIR, 'ended');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'photos');

// Ensure directories exist
[SESSIONS_DIR, ENDED_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Session storage - Map of sessionId -> session object
const sessions = new Map();
const userSessions = new Map(); // socketId -> sessionId

// Color palette for users
const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'
];
let colorIndex = 0;

function getNextColor() {
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return color;
}

// ========== SESSION MANAGEMENT ==========

function loadAllSessions() {
  console.log('Loading all sessions from disk...');
  
  // Load active sessions
  const activeFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  activeFiles.forEach(file => {
    try {
      const filepath = path.join(SESSIONS_DIR, file);
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      
      if (data.status === 'ACTIVE') {
        // Reset online users (will be populated as users reconnect)
        data.onlineUsers = {};
        sessions.set(data.id, data);
        console.log(`Loaded ACTIVE session: ${data.name} (${data.id})`);
      }
    } catch (err) {
      console.error(`Error loading session ${file}:`, err);
    }
  });
  
  console.log(`Loaded ${sessions.size} active sessions`);
}

function saveSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Cannot save - session not found:', sessionId);
    return;
  }
  
  try {
    const filepath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    fs.writeFileSync(filepath, JSON.stringify(session, null, 2));
    console.log(`Saved session: ${session.name} (${sessionId})`);
  } catch (err) {
    console.error(`Error saving session ${sessionId}:`, err);
  }
}

function createSession(name) {
  const session = {
    id: `session_${Date.now()}`,
    name: name || 'New Session',
    createdAt: new Date().toISOString(),
    status: 'ACTIVE',
    endedAt: null,
    users: [],
    onlineUsers: {}, // socketId -> userName
    markers: [],
    messages: []
  };
  
  sessions.set(session.id, session);
  saveSession(session.id);
  
  console.log(`Session created: ${session.name} (${session.id})`);
  return session;
}

function joinSession(socketId, sessionId, userName) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found:', sessionId);
    return null;
  }

  // Add to online users
  session.onlineUsers[socketId] = userName;

  // Check if user already exists in users list
  let user = session.users.find(u => u.name === userName);

  if (!user) {
    // New user - add to users list
    user = {
      name: userName,
      color: getNextColor(),
      path: [],
      tracking: true,
      lastOnline: new Date().toISOString()
    };
    session.users.push(user);
    console.log(`New user added to session: ${userName}`);
  } else {
    // Returning user - update lastOnline
    user.lastOnline = new Date().toISOString();
    console.log(`Returning user joined: ${userName}`);
  }

  console.log(`[DEBUG] Session ${session.name} now has ${session.users.length} users:`,
    session.users.map(u => u.name));

  // Track which session this socket is in
  userSessions.set(socketId, sessionId);

  // Save to disk
  saveSession(sessionId);

  return session;
}

function leaveSession(socketId) {
  const sessionId = userSessions.get(socketId);
  if (!sessionId) return;
  
  const session = sessions.get(sessionId);
  if (session) {
    // Remove from online users
    delete session.onlineUsers[socketId];
    saveSession(sessionId);
  }
  
  userSessions.delete(socketId);
}

function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found:', sessionId);
    return null;
  }

  // Get online users BEFORE deleting session (for broadcasting)
  const onlineSocketIds = Object.keys(session.onlineUsers);

  // Update status
  session.status = 'END';
  session.endedAt = new Date().toISOString();

  // Generate filename for ended session
  const date = new Date(session.endedAt);
  const dateStr = date.toISOString().split('T')[0];
  const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-');
  const safeName = session.name.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
  const filename = `session_${dateStr}_${timeStr}_${safeName}.json`;

  const result = {
    sessionId,
    filename,
    sessionName: session.name,
    endedAt: session.endedAt
  };

  // Broadcast to all online users BEFORE deleting session
  onlineSocketIds.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('session:ended', result);
    }
  });

  // Move to ended folder
  try {
    const oldPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    const newPath = path.join(ENDED_DIR, filename);

    fs.writeFileSync(newPath, JSON.stringify(session, null, 2));
    fs.unlinkSync(oldPath);

    console.log(`Session ended and moved to: ${filename}`);
  } catch (err) {
    console.error('Error moving session to ended folder:', err);
  }

  // Remove from memory
  sessions.delete(sessionId);

  // Clear userSessions for users in this session
  userSessions.forEach((sid, sockId) => {
    if (sid === sessionId) {
      userSessions.delete(sockId);
    }
  });

  return result;
}

function broadcastToSession(sessionId, event, data) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Cannot broadcast - session not found:', sessionId);
    return;
  }

  const onlineSocketIds = Object.keys(session.onlineUsers);
  console.log(`Broadcasting ${event} to ${onlineSocketIds.length} users in session ${session.name}`);

  // If broadcasting users:update, ensure all users have lat/lng from path
  if (event === 'users:update' && data.users) {
    data.users = data.users.map(user => {
      // If user doesn't have lat/lng but has path, use last path point
      if ((!user.lat || !user.lng) && user.path && user.path.length > 0) {
        const lastPoint = user.path[user.path.length - 1];
        return {
          ...user,
          lat: lastPoint.lat,
          lng: lastPoint.lng
        };
      }
      return user;
    });
  }

  onlineSocketIds.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit(event, data);
    }
  });
}

// ========== SOCKET EVENTS ==========

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Send list of active sessions
  const activeSessionsList = Array.from(sessions.values())
    .filter(s => s.status === 'ACTIVE')
    .map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      userCount: Object.keys(s.onlineUsers).length,
      totalUsers: s.users.length,
      markerCount: s.markers.length
    }));
  
  socket.emit('sessions:list', activeSessionsList);
  
  // Join a specific session
  socket.on('session:join', (data) => {
    const { sessionId, userName, lat, lng } = data;

    console.log(`User ${userName} joining session ${sessionId} at (${lat}, ${lng})`);

    const session = joinSession(socket.id, sessionId, userName);
    if (!session) {
      return socket.emit('error', { message: 'Session not found' });
    }

    // Update user position if provided
    if (lat && lng) {
      const user = session.users.find(u => u.name === userName);
      if (user) {
        user.lat = lat;
        user.lng = lng;
      }
    }

    // Send full session data to user
    socket.emit('session:joined', {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      users: session.users,
      onlineUsers: Object.values(session.onlineUsers), // Send user names
      markers: session.markers,
      messages: session.messages
    });

    // Broadcast updated user list to all users in this session
    broadcastToSession(sessionId, 'users:update', {
      users: session.users,
      onlineUsers: Object.values(session.onlineUsers) // Send user names
    });
    
    // Broadcast updated session list to all connected clients
    const activeSessionsList = Array.from(sessions.values())
      .filter(s => s.status === 'ACTIVE')
      .map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        userCount: Object.keys(s.onlineUsers).length,
        totalUsers: s.users.length,
        markerCount: s.markers.length
      }));
    io.emit('sessions:list', activeSessionsList);
  });
  
  // Create a new session
  socket.on('session:create', (sessionName) => {
    const session = createSession(sessionName);
    
    socket.emit('session:created', {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt
    });
    
    // Broadcast updated session list
    const activeSessionsList = Array.from(sessions.values())
      .filter(s => s.status === 'ACTIVE')
      .map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        userCount: Object.keys(s.onlineUsers).length,
        totalUsers: s.users.length,
        markerCount: s.markers.length
      }));
    io.emit('sessions:list', activeSessionsList);
  });
  
  // Update position
  socket.on('user:position', (position) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;
    
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const userName = session.onlineUsers[socket.id];
    const user = session.users.find(u => u.name === userName);
    
    if (user && position.lat && position.lng) {
      // Update user's current position (always)
      user.lat = position.lat;
      user.lng = position.lng;

      // Add to path if tracking enabled and moved enough
      if (user.tracking) {
        const lastPoint = user.path[user.path.length - 1];
        const shouldRecord = !lastPoint || 
          calculateDistance(lastPoint.lat, lastPoint.lng, position.lat, position.lng) >= 5;

        if (shouldRecord) {
          user.path.push({
            lat: position.lat,
            lng: position.lng,
            timestamp: Date.now()
          });

          // Save periodically (not every update)
          if (user.path.length % 10 === 0) {
            saveSession(sessionId);
          }
        }
      }
    }
    
    // Broadcast to session members
    broadcastToSession(sessionId, 'user:position', {
      userName,
      lat: position.lat,
      lng: position.lng
    });
  });
  
  // Add marker
  socket.on('marker:add', (markerData) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;
    
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const userName = session.onlineUsers[socket.id];
    const user = session.users.find(u => u.name === userName);
    
    const marker = {
      id: `marker_${Date.now()}`,
      lat: markerData.lat,
      lng: markerData.lng,
      label: markerData.label || '',
      createdBy: userName,
      color: user ? user.color : '#3498db',
      icon: markerData.icon || '📍',
      photo: markerData.photo || null,
      createdAt: new Date().toISOString()
    };
    
    session.markers.push(marker);
    saveSession(sessionId);
    
    broadcastToSession(sessionId, 'marker:added', marker);
  });

  // Remove marker
  socket.on('marker:remove', (markerId) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    // Remove marker from session
    const markerIndex = session.markers.findIndex(m => m.id === markerId);
    if (markerIndex !== -1) {
      session.markers.splice(markerIndex, 1);
      saveSession(sessionId);
      broadcastToSession(sessionId, 'marker:removed', markerId);
      console.log(`Marker ${markerId} removed from session ${session.name}`);
    }
  });

  // Add message
  socket.on('message:add', (messageData) => {
    const sessionId = userSessions.get(socket.id);
    if (!sessionId) return;
    
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const userName = session.onlineUsers[socket.id];
    const user = session.users.find(u => u.name === userName);
    
    const message = {
      id: `msg_${Date.now()}`,
      text: messageData.text,
      author: userName,
      color: user ? user.color : '#3498db',
      timestamp: Date.now()
    };
    
    session.messages.push(message);
    saveSession(sessionId);
    
    broadcastToSession(sessionId, 'message:new', message);
  });
  
  // End session
  socket.on('session:end', (sessionId) => {
    const result = endSession(sessionId);
    if (result) {
      // Notify all users in this session
      broadcastToSession(sessionId, 'session:ended', result);
      
      // Broadcast updated session list
      const activeSessionsList = Array.from(sessions.values())
        .filter(s => s.status === 'ACTIVE')
        .map(s => ({
          id: s.id,
          name: s.name,
          createdAt: s.createdAt,
          userCount: Object.keys(s.onlineUsers).length,
          totalUsers: s.users.length,
          markerCount: s.markers.length
        }));
      io.emit('sessions:list', activeSessionsList);
    }
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    const sessionId = userSessions.get(socket.id);

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        const userName = session.onlineUsers[socket.id];
        console.log(`User disconnected: ${userName} from session ${session.name}`);

        // Get online user names BEFORE removing
        const onlineUserNames = Object.values(session.onlineUsers);

        // Remove from online users
        delete session.onlineUsers[socket.id];
        userSessions.delete(socket.id);
        saveSession(sessionId);

        // Broadcast updated user list (with updated onlineUsers)
        broadcastToSession(sessionId, 'users:update', {
          users: session.users,
          onlineUsers: Object.values(session.onlineUsers) // Send user names, not socket IDs
        });
      }
    }

    // Broadcast updated session list
    const activeSessionsList = Array.from(sessions.values())
      .filter(s => s.status === 'ACTIVE')
      .map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        userCount: Object.keys(s.onlineUsers).length,
        totalUsers: s.users.length,
        markerCount: s.markers.length
      }));
    io.emit('sessions:list', activeSessionsList);
  });
});

// ========== HELPER FUNCTIONS ==========

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  
  return R * c;
}

// ========== API ENDPOINTS ==========

// Get all active sessions
app.get('/api/sessions', (req, res) => {
  const activeSessions = Array.from(sessions.values())
    .filter(s => s.status === 'ACTIVE')
    .map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      userCount: Object.keys(s.onlineUsers).length,
      totalUsers: s.users.length,
      markerCount: s.markers.length
    }));
  
  res.json(activeSessions);
});

// Get ended sessions
app.get('/api/sessions/past', (req, res) => {
  try {
    const files = fs.readdirSync(ENDED_DIR).filter(f => f.endsWith('.json'));
    const endedSessions = files.map(file => {
      try {
        const filepath = path.join(ENDED_DIR, file);
        const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        return {
          filename: file,
          name: data.name,
          createdAt: data.createdAt,
          endedAt: data.endedAt,
          userCount: data.users ? data.users.length : 0,
          markerCount: data.markers ? data.markers.length : 0
        };
      } catch (err) {
        return null;
      }
    }).filter(s => s !== null);

    res.json(endedSessions);
  } catch (err) {
    res.json([]);
  }
});

// Get single session details (for replay)
app.get('/api/sessions/:filename', (req, res) => {
  try {
    const { filename } = req.params;

    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Try ended sessions first
    let filepath = path.join(ENDED_DIR, filename);

    // If not found in ended, try active sessions
    if (!fs.existsSync(filepath)) {
      filepath = path.join(SESSIONS_DIR, filename);
    }

    // If still not found, return 404
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Read and return session data
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    res.json(data);
  } catch (err) {
    console.error('Error loading session:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// Photo upload
app.post('/api/upload-photo', async (req, res) => {
  try {
    const { photo } = req.body;
    if (!photo) {
      return res.status(400).json({ error: 'No photo provided' });
    }
    
    const matches = photo.match(/^data:image\/(png|jpeg|jpg|heic|webp);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid photo format' });
    }
    
    const imageData = Buffer.from(matches[2], 'base64');
    const filename = `photo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);
    
    const compressedBuffer = await sharp(imageData)
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer();
    
    fs.writeFileSync(filepath, compressedBuffer);
    
    const photoUrl = `/uploads/photos/${filename}`;
    res.json({ url: photoUrl, size: Math.round(compressedBuffer.length / 1024) });
  } catch (error) {
    console.error('Error uploading photo:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
  
  // Load all active sessions from disk
  loadAllSessions();
  
  // Save all sessions every 30 seconds
  setInterval(() => {
    sessions.forEach((session, sessionId) => {
      saveSession(sessionId);
    });
    if (sessions.size > 0) {
      console.log(`Auto-saved ${sessions.size} sessions`);
    }
  }, 30000);
  
  console.log(`Multi-session server ready (${sessions.size} sessions loaded)`);
});
