# Multi-Session Migration Guide

## Problem
Current architecture uses single `currentSession`, causing:
- User B creating session ends User A's session
- No parallel session support
- Session data conflicts

## Solution
Refactor to support multiple sessions in parallel:
- `sessions` Map stores all active sessions
- Each user joins a specific session by ID
- Sessions are completely independent

## Architecture Change

### Before (Wrong)
```javascript
let currentSession = null; // Only one session

socket.on('session:create', () => {
  if (currentSession) {
    endSession(); // ❌ Ends all users' session!
  }
  createSession();
});
```

### After (Correct)
```javascript
const sessions = new Map(); // Multiple sessions

socket.on('session:create', (name) => {
  const session = createSession(name);
  socket.emit('session:created', session);
  // ✅ Doesn't affect other sessions
});

socket.on('session:join', (sessionId) => {
  const session = sessions.get(sessionId);
  joinSession(socket.id, user, sessionId);
  // ✅ User joins specific session
});
```

## Implementation Steps

1. ✅ Change `currentSession` to `sessions` Map
2. ✅ Modify `createSession()` to add to Map
3. ✅ Modify `joinSession()` to accept `sessionId`
4. ✅ Modify `endSession()` to end specific session
5. ✅ Update all socket handlers
6. ✅ Update API endpoints
7. ✅ Update client-side code

## File Structure
```
sessions/
  ├─ session_123456.json (active session)
  ├─ session_789012.json (active session)
  └─ ended/
      ├─ session_2026-03-06_15-30-00_Name.json
      └─ session_2026-03-06_16-00-00_Name.json
```

## API Changes

### New Endpoints
- `GET /api/sessions/active` - List all active sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions/:id` - Get session by ID
- `DELETE /api/sessions/:id` - End specific session

### Socket Events
- `session:list` - Get all active sessions
- `session:create` - Create new session (returns session ID)
- `session:join` - Join specific session by ID
- `session:leave` - Leave current session
- `session:end` - End specific session (only if user is in it)

## Testing
1. User A creates session A
2. User B creates session B
3. ✅ Both sessions exist in parallel
4. User C joins session A
5. ✅ User C sees User A's data, not User B's
6. User A ends session A
7. ✅ Session B still active
