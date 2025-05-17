const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { config } = require("dotenv");
const { BlobServiceClient } = require("@azure/storage-blob");
const multer = require("multer");
const cors = require("cors");

config();

const CORS_ORIGIN_BASE_URL =
  process.env.CORS_ORIGIN_BASE_URL || "http://localhost:3000";
const PORT = 8080;

const app = express();
app.use(cors());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN_BASE_URL },
});

app.get("/", (req, res) => {
  res.send("Hello World");
});

// Azure Blob Setup
const accountKey = atob(
  "RVFCQUNpQW5sN0lYMXlzd1hqMVY1WWMzZGVxd21EWS9pMGg2cWNFOTFFYUQ1ZWxySjVyTW92VGpiRnc2UG9FS0xKVEVCRXFJejZpQitBU3RpSjBwWlE9PQ=="
);
const blobServiceClient = BlobServiceClient.fromConnectionString(
  `DefaultEndpointsProtocol=https;AccountName=seismicaml3776953091;AccountKey=${accountKey};EndpointSuffix=core.windows.net`
);
const containerClient = blobServiceClient.getContainerClient(
  "seismic-dev-container"
);

// Multer config
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Chunk Upload Endpoint
app.post(
  "/upload-chunk/:id/:chunkIndex",
  upload.single("chunk"),
  async (req, res) => {
    try {
      const { id, chunkIndex } = req.params;
      const chunk = req.file.buffer;

      const blobName = `testuser/${id}/meeting_part${chunkIndex}.webm`;
      const blobClient = containerClient.getBlockBlobClient(blobName);

      await blobClient.uploadData(chunk, {
        blobHTTPHeaders: { blobContentType: "video/webm" },
      });

      res.status(200).json({ success: true, chunkIndex, blobName });
    } catch (error) {
      console.error("Chunk upload failed:", error);
      res.status(500).json({ error: "Chunk upload failed" });
    }
  }
);

const rooms = {}; // { [roomId]: [{ socketId, nickname, role }] }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Create a new room
  socket.on("createRoom", ({ roomId, nickname, role }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = [{ socketId: socket.id, nickname, role }];
      console.log(`Room ${roomId} created by ${nickname} as ${role}`);
      socket.emit("roomCreated", { roomId });
    } else {
      socket.emit("roomExists", { roomId });
    }
  });

  socket.on("joinRoom", (args) => {
    const { roomId, nickname, role } = args;

    if (rooms[roomId])
      rooms[roomId].push({ socketId: socket.id, nickname, role });
    else rooms[roomId] = [{ socketId: socket.id, nickname, role }];

    const otherUser = rooms[roomId].find((item) => item.socketId !== socket.id);

    if (otherUser && otherUser.socketId !== socket.id) {
      // Only allow patients to request joining if the other user is a doctor
      if (role === "patient" && otherUser.role === "doctor") {
        socket.to(otherUser.socketId).emit("userJoined", {
          otherUserSocketId: socket.id,
          otherUserNickname: nickname,
          otherUserRole: role,
        });
        socket.emit("waitingToBeAcceptedBy", otherUser.nickname);
      } else if (role === "doctor" && otherUser.role === "patient") {
        // If doctor joins after patient, automatically accept
        socket.emit("otherUserId", {
          otherUserSocketId: otherUser.socketId,
          otherUserNickname: otherUser.nickname,
          otherUserRole: otherUser.role,
        });
        socket.to(otherUser.socketId).emit("acceptedBy", nickname);
      } else {
        // If roles don't match, reject the connection
        socket.emit("invalidRoleCombination");
        rooms[roomId] = rooms[roomId].filter((el) => el.socketId !== socket.id);
      }
    }
    console.log("joinRoom rooms: ", rooms);
  });

  socket.on("callAccepted", (args) => {
    const { roomId, nickname } = args;

    const room = rooms[roomId];
    const otherUser = room.find((item) => item.socketId !== socket.id);
    if (otherUser) {
      // Only allow doctors to accept calls
      const currentUser = room.find((item) => item.socketId === socket.id);
      if (currentUser?.role === "doctor" || "patient") {
        socket.emit("otherUserId", {
          otherUserSocketId: otherUser.socketId,
          otherUserNickname: otherUser.nickname,
          otherUserRole: otherUser.role,
        });
        socket.to(otherUser.socketId).emit("acceptedBy", nickname);
      } else {
        socket.emit("unauthorizedAcceptance");
      }
    }
  });

  socket.on("offer", (payload) => {
    io.to(payload.target).emit("offer", payload);
  });

  socket.on("answer", (payload) => {
    io.to(payload.target).emit("answer", payload);
  });

  socket.on("ICECandidate", (payload) => {
    io.to(payload.target).emit("ICECandidate", payload.candidate);
  });

  socket.on("disconnect", (reason) => {
    let roomId = null;
    for (let id in rooms) {
      const found = rooms[id].find((item) => item.socketId === socket.id);
      if (found) {
        roomId = id;
        break;
      }
    }
    if (roomId) {
      const room = rooms[roomId];
      const otherUser = room.find((item) => item.socketId !== socket.id);
      rooms[roomId] = rooms[roomId].filter((el) => el.socketId !== socket.id);
      if (otherUser)
        socket
          .to(otherUser.socketId)
          .emit("otherUserDisconnected", otherUser.nickname);
    }
    console.log("disconnect rooms: ", rooms);
  });

  socket.on("callRejected", (args) => {
    const { roomId, nickname } = args;

    const otherUser = rooms[roomId].find((el) => el.socketId !== socket.id);
    if (otherUser) {
      rooms[roomId] = rooms[roomId].filter(
        (el) => el.socketId !== otherUser.socketId
      );
      socket.to(otherUser.socketId).emit("callRejected", nickname);
    }
    console.log("callRejected rooms: ", rooms);
  });
});

httpServer.listen(PORT, () =>
  console.log(`server is running on port: ${PORT}`)
);
