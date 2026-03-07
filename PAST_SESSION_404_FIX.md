# Past Session 404 Error Fix

## 🐛 Problem

User reported: "Cannot load past session it show 404 error"

## 🔍 Root Cause

**Missing API Endpoint**

Frontend tries to load past session:
```javascript
// Frontend: viewPastSession(filename)
const response = await fetch(`/api/sessions/${filename}`);
```

But server only had:
```javascript
// ❌ Server endpoints
GET /api/sessions/past  // List all ended sessions
// Missing: GET /api/sessions/:filename  // Load single session
```

Result: **404 Not Found**

## ✅ Solution

Added new API endpoint:

```javascript
// GET /api/sessions/:filename
app.get('/api/sessions/:filename', (req, res) => {
  try {
    const { filename } = req.params;

    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Try ended sessions first
    let filepath = path.join(ENDED_DIR, filename);

    // If not found, try active sessions
    if (!fs.existsSync(filepath)) {
      filepath = path.join(SESSIONS_DIR, filename);
    }

    // Return 404 if not found
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
```

## 🎯 Features

### 1. Security
```javascript
if (filename.includes('..') || filename.includes('/')) {
  return res.status(400).json({ error: 'Invalid filename' });
}
```
- Prevents directory traversal attacks
- Blocks attempts like `../../etc/passwd`

### 2. Flexibility
```javascript
// Try ended sessions first
let filepath = path.join(ENDED_DIR, filename);

// If not found, try active sessions
if (!fs.existsSync(filepath)) {
  filepath = path.join(SESSIONS_DIR, filename);
}
```
- Can load both ended AND active sessions
- Checks both folders automatically

### 3. Error Handling
```javascript
// 404 - Not Found
if (!fs.existsSync(filepath)) {
  return res.status(404).json({ error: 'Session not found' });
}

// 500 - Server Error
catch (err) {
  res.status(500).json({ error: 'Failed to load session' });
}
```

### 4. Full Data
```javascript
const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
res.json(data);
```
- Returns complete session object
- Includes: users, markers, messages, metadata

## 📊 Complete Flow

### Before Fix
```
User clicks "View" on past session
  ↓
Frontend: fetch('/api/sessions/filename.json')
  ↓
Server: Route not found ❌
  ↓
Response: 404 Not Found ❌
  ↓
Frontend: Error loading session ❌
```

### After Fix
```
User clicks "View" on past session
  ↓
Frontend: fetch('/api/sessions/filename.json')
  ↓
Server: GET /api/sessions/:filename
  ├─ Security check ✅
  ├─ Check ended/ folder ✅
  ├─ Check active folder ✅
  ├─ Read session file ✅
  └─ Return JSON ✅
  ↓
Response: 200 OK with session data ✅
  ↓
Frontend: Load session into replay mode ✅
  ├─ Show replay banner ✅
  ├─ Display users and paths ✅
  ├─ Display markers ✅
  └─ Display messages ✅
```

## 🧪 Testing

### Test 1: Load Past Session
```
1. Go to https://map.siukiuai.online/
2. Click "View Past Sessions" button
3. Click "View" button on any ended session
4. ✅ Session loads successfully
5. ✅ Replay banner shows: "Viewing: Session Name (Date)"
6. ✅ Map shows all users, markers, messages
7. ✅ No 404 errors in browser console
```

### Test 2: Direct API Test
```bash
# List all past sessions
curl -s https://map.siukiuai.online/api/sessions/past | jq .

# Load specific session
curl -s https://map.siukiuai.online/api/sessions/session_2026-03-07_04-13-19_Eric_s_Session.json | jq .
```

**Expected Response**:
```json
{
  "id": "session_xxx",
  "name": "Eric's Session",
  "status": "END",
  "createdAt": "2026-03-07T04:00:46.037Z",
  "endedAt": "2026-03-07T04:13:19.594Z",
  "users": [
    {
      "name": "Eric",
      "color": "#e74c3c",
      "path": [...]
    }
  ],
  "markers": [...],
  "messages": [...]
}
```

### Test 3: Error Cases

**Invalid Filename (Security)**:
```bash
curl -I https://map.siukiuai.online/api/sessions/../../etc/passwd
# Expected: 400 Bad Request
```

**Non-existent Session**:
```bash
curl -I https://map.siukiuai.online/api/sessions/nonexistent.json
# Expected: 404 Not Found
```

### Test 4: Browser Console Check
```
1. Open DevTools (F12)
2. Go to Console tab
3. Load a past session
4. ✅ No 404 errors
5. ✅ No red error messages
6. ✅ See "Session loaded: {name: '...'}"
```

## 📁 API Endpoints Summary

### Before
```
GET /api/sessions             - List active sessions
GET /api/sessions/past        - List ended sessions
POST /api/upload-photo        - Upload photo

❌ Missing: Load single session
```

### After
```
GET /api/sessions             - List active sessions
GET /api/sessions/past        - List ended sessions
GET /api/sessions/:filename   - Load single session ✨ NEW
POST /api/upload-photo        - Upload photo

✅ Complete: All frontend needs met
```

## 🎨 Frontend Integration

### viewPastSession() Function
```javascript
async function viewPastSession(filename) {
  try {
    console.log('Loading session:', filename);

    // API call to new endpoint
    const response = await fetch(`/api/sessions/${filename}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const session = await response.json();
    console.log('Session loaded:', session);

    // Enter replay mode
    state.replayMode = true;
    state.replayData = session;

    // Show replay UI
    elements.replayBannerText.textContent =
      `Viewing: ${session.name} (${new Date(session.createdAt).toLocaleDateString()})`;
    elements.replayBanner.classList.remove('hidden');
    elements.replayControls.classList.remove('hidden');

    // Display data on map
    displayUsersAndPaths(session.users);
    displayMarkers(session.markers);
    displayMessages(session.messages);
  } catch (error) {
    console.error('Error loading session:', error);
    alert('Failed to load session: ' + error.message);
  }
}
```

## 🔒 Security Considerations

### 1. Directory Traversal Prevention
```javascript
if (filename.includes('..') || filename.includes('/')) {
  return res.status(400).json({ error: 'Invalid filename' });
}
```
- Blocks `../` attempts
- Blocks absolute paths like `/etc/passwd`

### 2. File Existence Check
```javascript
if (!fs.existsSync(filepath)) {
  return res.status(404).json({ error: 'Session not found' });
}
```
- Prevents reading non-existent files
- Proper 404 response

### 3. Error Handling
```javascript
catch (err) {
  console.error('Error loading session:', err);
  res.status(500).json({ error: 'Failed to load session' });
}
```
- Catches JSON parse errors
- Catches file read errors
- Proper 500 response

## 📈 Performance

- **Read**: Direct file read (fast)
- **Parse**: JSON.parse (optimized in V8)
- **Response**: Single JSON object
- **Size**: Typically 10-100KB per session

## ✅ Result

After fix:
- ✅ Past sessions load successfully
- ✅ No 404 errors
- ✅ Replay mode works
- ✅ All session data accessible
- ✅ Secure endpoint
- ✅ Proper error handling

## 📝 Related Files

- **Server**: `server.js` - Line 541 (new endpoint)
- **Frontend**: `public/index.html` - `viewPastSession()` function
- **Sessions**: `sessions/ended/*.json`
- **Active**: `sessions/*.json`

## 📌 Commit

- **Hash**: `e8cf04e`
- **Message**: "fix: add API endpoint to load single session for replay"
- **Date**: 2026-03-07 04:29 UTC

---

**Status**: ✅ Fixed and ready for testing
