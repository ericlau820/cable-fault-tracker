# Cable Fault Path Tracker 📍

Real-time collaborative GPS tracking application for cable fault location and management.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)

## Features ✨

### Core Features
- 🗺️ **Real-time GPS Tracking** - Track team members' locations in real-time
- 📍 **Marker System** - Place markers with custom icons and labels
- 💬 **Chat System** - Real-time messaging with notifications
- 📊 **Session Management** - Create, join, and review past sessions
- 📱 **PWA Support** - Install as mobile app with offline support

### Cable Fault Specific
- 📏 **Distance Measurement** - Measure cable lengths and fault distances
- 📷 **Photo Attachments** - Attach photos to fault markers
- 🎨 **Custom Markers** - 32+ icons for different fault types
- 📝 **Fault Documentation** - Label and document fault locations

### Technical Features
- 🔒 **Session Persistence** - Sessions saved to JSON files
- 🔄 **Path Restoration** - Returning users get their previous paths
- 👥 **Multi-user Collaboration** - Real-time sync across all users
- 📡 **GPS Auto-tracking** - Automatic position updates

## Tech Stack 🛠️

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: Vanilla JavaScript, Leaflet.js
- **Maps**: OpenStreetMap
- **Storage**: File-based JSON storage
- **PWA**: Service Worker, Web App Manifest

## Installation 📦

### Prerequisites
- Node.js >= 14.0.0
- npm or yarn

### Setup

```bash
# Clone the repository
git clone https://github.com/ericlau820/cable-fault-tracker.git
cd cable-fault-tracker

# Install dependencies
npm install

# Start the server
npm start

# Or use PM2 for production
pm2 start server.js --name cable-fault-tracker
```

### Environment Variables

Create a `.env` file (optional):

```env
PORT=3000
```

## Usage 📖

### Starting a Session

1. Open the app in your browser
2. Enter your name
3. Create a new session or join an existing one
4. Allow location access when prompted

### Adding Markers

1. Click **"Add Marker"** button
2. Choose placement method:
   - **📍 Current Position** - Use your GPS location
   - **🗺️ Pick on Map** - Click on map to place
3. Select an icon (32+ options available)
4. Add a label (optional)
5. Attach a photo (optional)
6. Confirm to place marker

### Measuring Distances

1. Click **"📏 Measure"** button
2. Click multiple points on the map
3. View segment distances and total distance
4. Click **✕** to clear measurement

### Sending Messages

1. Click the **"+"** button in the Messages section
2. Type your message
3. Press Enter or click **"Send"**

### Viewing Past Sessions

1. Click **"View Past Sessions"** on welcome screen
2. Select a session to view (read-only)
3. Click **"Exit Replay"** to return

## Deployment 🚀

### Using PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start server.js --name cable-fault-tracker

# Save PM2 configuration
pm2 save

# Auto-start on boot
pm2 startup
```

### Using Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name map.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## API Reference 📚

### Socket.io Events

#### Client → Server
- `user:join` - Join a session
- `user:position` - Update position
- `user:toggleTracking` - Toggle GPS tracking
- `user:clearPath` - Clear path history
- `marker:add` - Add a marker
- `marker:remove` - Remove a marker
- `message:add` - Send a message
- `session:end` - End current session

#### Server → Client
- `user:assigned` - User ID and color assigned
- `users:update` - User list updated
- `markers:update` - Marker list updated
- `marker:added` - New marker added
- `marker:removed` - Marker removed
- `message:new` - New message received
- `message:history` - Chat history
- `session:info` - Session metadata
- `session:ended` - Session ended

### REST API

```bash
# Get saved sessions
GET /api/sessions

# Get specific session
GET /api/sessions/:filename

# Delete session
DELETE /api/sessions/:filename

# Get current session info
GET /api/current-session
```

## Configuration ⚙️

### Map Settings
- Default zoom level: 2
- Max zoom: 19
- Min distance threshold: 5 meters

### Marker Icons
32+ icons available:
- Directions: ➡️⬅️⬆️⬇️↗️↘️↙️↖️
- Colors: 🔴🟠🟡🟢🔵🟣⚫️
- Status: ⚠️❌⭕️⛔️✅❎
- Objects: 🚐🏠
- Numbers: 1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣

## Browser Support 🌐

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+
- Mobile browsers (iOS Safari, Chrome for Android)

## Contributing 🤝

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## License 📄

MIT License - see [LICENSE](LICENSE) file for details.

## Author 👨‍💻

**Eric Lau**
- GitHub: [@ericlau820](https://github.com/ericlau820)

## Acknowledgments 🙏

- [Leaflet.js](https://leafletjs.com/) - Maps library
- [OpenStreetMap](https://www.openstreetmap.org/) - Map data
- [Socket.io](https://socket.io/) - Real-time communication
- Icon generated by [Google Gemini AI](https://ai.google.dev/)

---

Made with ❤️ for cable fault tracking teams