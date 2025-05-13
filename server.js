const express = require("express");
const app = express();
const server = require("http").createServer(app);
const { BlobServiceClient } = require("@azure/storage-blob");
const cors = require("cors");
const multer = require("multer");

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());

const PORT = process.env.PORT || 8080;

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

// Track rooms and participants
const activeRooms = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Create a new room
  socket.on("create-room", ({ roomId, appointmentDetails }) => {
    if (!activeRooms.has(roomId)) {
      activeRooms.set(roomId, {
        doctor: null,
        participants: new Map(),
        appointmentDetails,
      });
      console.log(`Room ${roomId} created`);
      socket.emit("room-created", { roomId });
    } else {
      socket.emit("room-exists", { roomId });
    }
  });

  // Patient joins room
  socket.on("join-as-participant", ({ roomId, name }) => {
    const room = activeRooms.get(roomId);
    if (!room) {
      socket.emit("room-not-found");
      return;
    }

    room.participants.set(socket.id, { name });
    socket.join(roomId);
    socket.data = { roomId, isDoctor: false, name };

    console.log(`Participant ${name} joined room ${roomId}`);

    if (room.doctor) {
      socket.emit("doctor-present", { doctorName: room.doctor.name });
      io.to(room.doctor.socketId).emit("user-joined", { id: socket.id, name });
    } else {
      socket.emit("waiting-for-doctor");
    }
  });

  // Doctor joins room
  socket.on("join-as-doctor", ({ roomId, name }) => {
    const room = activeRooms.get(roomId);
    if (!room) {
      socket.emit("room-not-found");
      return;
    }

    room.doctor = { socketId: socket.id, name };
    socket.join(roomId);
    socket.data = { roomId, isDoctor: true, name };

    console.log(`Doctor ${name} joined room ${roomId}`);

    // Notify all participants
    socket.to(roomId).emit("doctor-joined", { name });

    // Send participants list to doctor
    const participants = Array.from(room.participants.entries()).map(
      ([id, data]) => ({ id, name: data.name })
    );
    socket.emit("current-participants", participants);
  });

  // WebRTC signaling
  socket.on("offer", ({ target, sdp }) => {
    socket.to(target).emit("offer", {
      sdp,
      sender: socket.id,
    });
  });

  socket.on("answer", ({ target, sdp }) => {
    socket.to(target).emit("answer", {
      sdp,
      sender: socket.id,
    });
  });

  socket.on("ice-candidate", ({ target, candidate }) => {
    socket.to(target).emit("ice-candidate", {
      candidate,
      sender: socket.id,
    });
  });

  // Leaving room
  socket.on("leave-room", () => {
    const { roomId } = socket.data || {};
    if (!roomId) return;

    const room = activeRooms.get(roomId);
    if (room) {
      if (socket.data.isDoctor) {
        room.doctor = null;
        socket.to(roomId).emit("doctor-left");
        console.log(`Doctor left room ${roomId}`);
      } else {
        room.participants.delete(socket.id);
        socket.to(roomId).emit("user-left", { id: socket.id });
        console.log(`Participant left room ${roomId}`);
      }
    }

    socket.leave(roomId);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const { roomId } = socket.data || {};
    if (!roomId) return;

    const room = activeRooms.get(roomId);
    if (room) {
      if (socket.data.isDoctor) {
        room.doctor = null;
        socket.to(roomId).emit("doctor-left");
        console.log(`Doctor disconnected from room ${roomId}`);
      } else {
        room.participants.delete(socket.id);
        socket.to(roomId).emit("user-left", { id: socket.id });
        console.log(`Participant disconnected from room ${roomId}`);
      }
    }

    socket.leave(roomId);
  });
});

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
