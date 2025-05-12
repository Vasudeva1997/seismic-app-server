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
const accountKey = atob("RVFCQUNpQW5sN0lYMXlzd1hqMVY1WWMzZGVxd21EWS9pMGg2cWNFOTFFYUQ1ZWxySjVyTW92VGpiRnc2UG9FS0xKVEVCRXFJejZpQitBU3RpSjBwWlE9PQ==");
const blobServiceClient = BlobServiceClient.fromConnectionString(
  `DefaultEndpointsProtocol=https;AccountName=seismicaml3776953091;AccountKey=${accountKey};EndpointSuffix=core.windows.net`
);
const containerClient = blobServiceClient.getContainerClient("seismic-dev-container");

// Multer config
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Chunk Upload Endpoint
app.post("/upload-chunk/:id/:chunkIndex", upload.single("chunk"), async (req, res) => {
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
});



io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", ({ roomId, name }) => {
    socket.join(roomId);
    socket.data.name = name; // store name in socket session
    socket.to(roomId).emit("user-joined", { id: socket.id, name });

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
      socket
        .to(roomId)
        .emit("user-disconnected", { id: socket.id, name: socket.data.name });
    });
  });
});

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
