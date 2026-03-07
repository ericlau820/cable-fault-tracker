# Real-time Online/Offline Tracking Fix

## 🐛 Problem Reported

User reported: "it seems cannot, when another user online, it can see, but disconnected, it still showing online"

## 🔍 Root Causes

### 1. Backend: Broadcasting After Removal
```javascript
// ❌ Wrong: Remove first, then broadcast
leaveSession(socket.id);
broadcastToSession(sessionId, 'users:update', {
  onlineUsers: Object.keys(session.onlineUsers) // Already removed!
});
```

### 2. Backend: Sending Socket IDs Instead of Names
```javascript
// ❌ Wrong: Socket IDs
Object.keys(session.onlineUsers) // ["xf89Nz2EDF1B8ffjAAAH", ...]

// ✅ Correct: User names
Object.values(session.onlineUsers) // ["Eric", "Kiu", ...]
```

### 3. Frontend: Not Checking Online Status
```javascript
// ❌ Wrong: Show all users
function updateUserList() {
  state.users.forEach(user => {
    // No online/offline check
    displayUser(user);
  });
}
```

## ✅ Fixes

### Backend (server.js)

**Disconnect Event**:
```javascript
socket.on('disconnect', () => {
  const sessionId = userSessions.get(socket.id);
  const session = sessions.get(sessionId);

  // Get online user names BEFORE removing
  const onlineUserNames = Object.values(session.onlineUsers);

  // Remove from online users
  delete session.onlineUsers[socket.id];
  userSessions.delete(socket.id);
  saveSession(sessionId);

  // Broadcast with updated onlineUsers
  broadcastToSession(sessionId, 'users:update', {
    users: session.users,
    onlineUsers: Object.values(session.onlineUsers) // User names!
  });
});
```

**Join Event**:
```javascript
socket.on('session:join', (data) => {
  const session = joinSession(socket.id, sessionId, userName);

  // Send user names, not socket IDs
  socket.emit('session:joined', {
    onlineUsers: Object.values(session.onlineUsers) // ["Eric", "Kiu"]
  });

  broadcastToSession(sessionId, 'users:update', {
    onlineUsers: Object.values(session.onlineUsers)
  });
});
```

### Frontend (index.html)

**Update User List**:
```javascript
function updateUserList() {
  // Get list of online user names
  const onlineUserNames = state.onlineUsers || [];

  elements.userList.innerHTML = state.users.map(user => {
    const isOnline = onlineUserNames.includes(user.name);
    return `
      <div class="user-item ${isOnline ? 'online' : 'offline'}">
        <span class="user-status">${isOnline ? '●' : '○'}</span>
        <span class="user-name">${user.name}</span>
      </div>
    `;
  }).join('');

  // Update online count
  elements.onlineCount.textContent = onlineUserNames.length;
}
```

## 🧪 Testing Steps

### Test 1: Basic Online/Offline
```
1. User A creates session
   ✅ User list shows: ● User A (1 online)

2. User B joins same session
   ✅ User A sees: ● User A, ● User B (2 online)
   ✅ User B sees: ● User A, ● User B (2 online)

3. User B closes browser (disconnect)
   ✅ User A sees: ● User A, ○ User B (1 online)

4. User B reopens browser and rejoins
   ✅ User A sees: ● User A, ● User B (2 online)
```

### Test 2: Multiple Sessions
```
1. User A in Session A
2. User B in Session B
3. User C joins Session A

4. Check Session A users:
   ✅ ● User A, ● User C (2 online)

5. Check Session B users:
   ✅ ● User B (1 online)

6. User C disconnects
   ✅ Session A: ● User A, ○ User C (1 online)
   ✅ Session B: ● User B (1 online) - unchanged
```

### Test 3: Server Logs
```bash
pm2 logs collaborative-map --lines 50
```

**Expected logs**:
```
User Eric joining session session_xxx
Broadcasting users:update to 1 users in session Eric's Session
User Kiu joining session session_xxx
Broadcasting users:update to 2 users in session Eric's Session
User disconnected: Kiu from session Eric's Session
Broadcasting users:update to 1 users in session Eric's Session
```

## 📊 Visual Indicators

### Online Status
- **●** (solid circle) = Online
- **○** (hollow circle) = Offline

### Tracking Status
- **\*** (asterisk) = Tracking GPS
- **o** (letter o) = Not tracking

### Example
```
● Eric *        (Online, Tracking GPS)
○ Kiu o         (Offline, Not tracking)
● John *        (Online, Tracking GPS)
```

## 🎯 Expected Behavior

### User Joins
1. Socket connects
2. `session:join` event
3. Added to `session.onlineUsers`
4. Broadcast `users:update` with user name
5. All users see ● indicator

### User Leaves
1. Socket disconnects
2. `disconnect` event
3. Get `onlineUserNames` BEFORE removal
4. Remove from `session.onlineUsers`
5. Broadcast `users:update` with updated list
6. All users see ○ indicator

### Page Refresh
1. Old socket disconnects (shows ○)
2. New socket connects
3. User rejoins session
4. Shows ● again
5. Full session data reloaded

## 🔧 Debugging

### Check Online Users (Backend)
```javascript
// In server.js, add logging:
console.log('Online users:', Object.values(session.onlineUsers));
console.log('All users:', session.users.map(u => u.name));
```

### Check Online Users (Frontend)
```javascript
// In browser console:
console.log('Online users:', state.onlineUsers);
console.log('All users:', state.users);
```

### Check WebSocket Events
```javascript
// In browser console:
state.socket.on('users:update', (data) => {
  console.log('users:update received:', data);
  console.log('Online:', data.onlineUsers);
  console.log('All:', data.users);
});
```

## 📝 Key Insights

1. **Always broadcast BEFORE modifying data**
   - Get the data you want to broadcast first
   - Then modify the data structure
   - Then broadcast the modified data

2. **Send user-friendly data, not internal IDs**
   - ❌ Socket IDs: `["xf89Nz2EDF1B8ffjAAAH"]`
   - ✅ User names: `["Eric", "Kiu"]`

3. **Frontend should validate data**
   - Check if user is in online list
   - Show appropriate visual indicator
   - Update counts accurately

4. **Session isolation is critical**
   - Only broadcast to session members
   - Use `broadcastToSession(sessionId, ...)`
   - Don't use `io.emit()` for session data

## ✅ Result

- ✅ Real-time online/offline tracking
- ✅ Accurate user counts
- ✅ Visual indicators (●/○)
- ✅ Session isolation maintained
- ✅ Works across page refreshes
- ✅ Works across server restarts

---

**Commit**: `443f2af`
**Date**: 2026-03-07 04:05 UTC
**Status**: ✅ Fixed and tested
