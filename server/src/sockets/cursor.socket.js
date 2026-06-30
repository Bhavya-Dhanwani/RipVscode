const registerCursorEvents = (io, socket) => {
  // Listen for remote cursor movements
  socket.on("cursor-move", ({ roomCode, offset }) => {
    socket.to(roomCode).emit("remote-cursor", {
      userId: socket.id,
      offset,
    });
  });

  // Listen for typing start
  socket.on("typing-start", ({ roomCode, participantId, displayName }) => {
    socket.to(roomCode).emit("typing-start", {
      participantId,
      displayName,
      userId: socket.id,
    });
  });

  // Listen for typing stop
  socket.on("typing-stop", ({ roomCode, participantId }) => {
    socket.to(roomCode).emit("typing-stop", {
      participantId,
      userId: socket.id,
    });
  });

  // Clean up remote cursors on disconnect
  socket.on("disconnecting", () => {
    socket.rooms.forEach((roomCode) => {
      if (roomCode !== socket.id) {
        socket.to(roomCode).emit("cursor-disconnect", {
          userId: socket.id,
        });
        socket.to(roomCode).emit("typing-stop", {
          userId: socket.id,
        });
      }
    });
  });
};

export default registerCursorEvents;
