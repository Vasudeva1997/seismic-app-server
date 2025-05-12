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

  socket.on("create-room", ({ roomId, appointmentDetails }) => {
    activeRooms.set(roomId, {
      doctor: null,
      participants: new Map(),
      appointmentDetails,
    });
    console.log(`Room ${roomId} created`);
  });

  socket.on("join-as-participant", ({ roomId, name }) => {
    if (!activeRooms.has(roomId)) {
      socket.emit("room-not-found");
      return;
    }

    const room = activeRooms.get(roomId);
    room.participants.set(socket.id, { name });
    socket.join(roomId);
    socket.data = { roomId, isDoctor: false };

    // Notify participant about room status
    if (room.doctor) {
      socket.emit("doctor-present");
    } else {
      socket.emit("waiting-for-doctor");
    }
  });

  socket.on("join-as-doctor", ({ roomId, name }) => {
    if (!activeRooms.has(roomId)) {
      socket.emit("room-not-found");
      return;
    }

    const room = activeRooms.get(roomId);
    room.doctor = { socketId: socket.id, name };
    socket.join(roomId);
    socket.data = { roomId, isDoctor: true };

    // Notify all participants
    socket.to(roomId).emit("doctor-joined", { name });

    // Send list of participants to doctor
    const participants = Array.from(room.participants.entries()).map(
      ([id, data]) => ({ id, name: data.name })
    );
    socket.emit("current-participants", participants);
  });

  socket.on("join-room", ({ roomId, name, isDoctor }) => {
    socket.join(roomId);
    socket.data = {
      name,
      isDoctor,
      roomId,
    };

    if (isDoctor) {
      // Notify all participants that doctor has joined
      socket.to(roomId).emit("doctor-joined");
      console.log(`Doctor ${name} joined room ${roomId}`);
    } else {
      // Notify doctor that user joined
      const doctorSockets = Array.from(io.sockets.sockets.values()).filter(
        (s) => s.data.isDoctor && s.data.roomId === roomId
      );

      if (doctorSockets.length > 0) {
        socket.to(doctorSockets[0].id).emit("user-joined", {
          id: socket.id,
          name,
        });
      } else {
        // No doctor in room yet
        socket.emit("waiting-for-doctor");
      }
    }

    socket.on("offer", (data) => {
      socket.to(data.target).emit("offer", {
        sdp: data.sdp,
        sender: socket.id,
      });
    });

    socket.on("answer", (data) => {
      socket.to(data.target).emit("answer", {
        sdp: data.sdp,
        sender: socket.id,
      });
    });

    socket.on("leave-room", (room) => {
      socket.leave(room);
      io.to(room).emit("user-left", socket.id);
    });

    socket.on("ice-candidate", (data) => {
      socket.to(data.target).emit("ice-candidate", {
        candidate: data.candidate,
        sender: socket.id,
      });
    });

    socket.on("disconnect", () => {
      if (socket.data.isDoctor) {
        socket.to(roomId).emit("doctor-left");
      }
      socket.to(roomId).emit("user-left", { id: socket.id });
    });
  });
});

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
