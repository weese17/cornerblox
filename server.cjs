const { createServer } = require("http");
const { Server } = require("socket.io");

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

const rooms = {};

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("join-room", (code) => {
    if (!rooms[code]) rooms[code] = [];
    const room = rooms[code];

    if (room.length >= 4) {
      socket.emit("room-full");
      return;
    }

    const playerIndex = room.length;
    room.push(socket.id);
    socket.join(code);
    socket.roomCode = code;
    socket.playerIndex = playerIndex;

    socket.emit("room-joined", { room: code, playerIndex });
    console.log(`Player ${playerIndex} joined room ${code}`);

    if (room.length >= 2) {
      io.to(code).emit("game-start", { numPlayers: room.length });
    }
  });

  socket.on("make-move", (gameState) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit("move-made", gameState);
    }
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    if (socket.roomCode && rooms[socket.roomCode]) {
      rooms[socket.roomCode] = rooms[socket.roomCode].filter(id => id !== socket.id);
      if (rooms[socket.roomCode].length === 0) delete rooms[socket.roomCode];
      else io.to(socket.roomCode).emit("player-left");
    }
  });
});

httpServer.listen(3001, () => {
  console.log("CornerBlox server running on port 3001");
});