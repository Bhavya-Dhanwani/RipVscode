const registerCursorEvents = (io, socket) => {
  // Identify a cursor by the participant id so the roster and carets share a key
  // (falling back to the socket id before the participant has joined).
  const cursorUserId = () => socket.data.participantId || socket.id;

  // 1. Listen for remote cursor movements
  socket.on("cursor-move", ({ roomCode, offset, displayName, color }) => {
    // Broadcast the cursor offset and identity to everyone else in the room
    socket.to(roomCode).emit("remote-cursor", {
      userId: cursorUserId(),
      offset,
      displayName,
      color,
    });
  });

  // 2. Listen for disconnection to clean up remote cursors
  socket.on("disconnecting", () => {
    socket.rooms.forEach((roomCode) => {
      if (roomCode !== socket.id) {
        socket.to(roomCode).emit("cursor-disconnect", {
          userId: cursorUserId(),
        });
      }
    });
  });
};
export default registerCursorEvents;
