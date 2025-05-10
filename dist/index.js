"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const http_1 = require("http");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const httpServer = (0, http_1.createServer)();
const wss = new ws_1.WebSocketServer({ server: httpServer });
const activeGames = new Map();
const playerConnections = new Map();
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function createSnakesAndLadders() {
    return {
        // Ladders (start -> end)
        1: 38,
        4: 14,
        9: 31,
        21: 42,
        28: 84,
        51: 67,
        72: 91,
        80: 99,
        // Snakes (start -> end)
        16: 6,
        47: 26,
        49: 11,
        56: 53,
        62: 19,
        64: 60,
        87: 24,
        93: 73,
        95: 75,
        98: 78,
    };
}
function broadcastToRoom(roomId, message) {
    const room = activeGames.get(roomId);
    if (!room)
        return;
    room.players.forEach(player => {
        const connection = playerConnections.get(player.id);
        if (connection && connection.readyState === 1) {
            connection.send(JSON.stringify(message));
        }
    });
}
wss.on('connection', (ws) => {
    let playerId = null;
    let currentRoomId = null;
    ws.on('message', (message) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const data = JSON.parse(message.toString());
            switch (data.type) {
                case 'CREATE_ROOM': {
                    const roomId = (0, crypto_1.randomUUID)();
                    const roomCode = generateRoomCode();
                    playerId = (0, crypto_1.randomUUID)();
                    const player = {
                        id: playerId,
                        name: data.playerName,
                        position: 0,
                        color: data.color || '#' + Math.floor(Math.random() * 16777215).toString(16)
                    };
                    const newRoom = {
                        id: roomId,
                        code: roomCode,
                        players: [player],
                        currentTurn: 0,
                        gameState: 'waiting',
                        snakesAndLadders: createSnakesAndLadders(),
                        boardSize: 100,
                        winner: null
                    };
                    activeGames.set(roomId, newRoom);
                    playerConnections.set(playerId, ws);
                    currentRoomId = roomId;
                    yield prisma.gameRoom.create({
                        data: {
                            id: roomId,
                            code: roomCode,
                            status: 'waiting',
                            players: {
                                create: {
                                    id: playerId,
                                    name: player.name,
                                    color: player.color
                                }
                            }
                        }
                    });
                    ws.send(JSON.stringify({
                        type: 'ROOM_CREATED',
                        room: {
                            id: roomId,
                            code: roomCode,
                            players: [player],
                            gameState: 'waiting'
                        },
                        playerId
                    }));
                    break;
                }
                case 'GET_ROOM_STATE': {
                    // Rename to avoid shadowing
                    const { roomCode, playerId: incomingPlayerId } = data;
                    // Find room by code
                    const roomEntry = Array.from(activeGames.entries())
                        .find(([_, room]) => room.code === roomCode);
                    if (!roomEntry) {
                        // Try to find in database if not in memory
                        const dbRoom = yield prisma.gameRoom.findFirst({
                            where: { code: roomCode },
                            include: { players: true }
                        });
                        if (!dbRoom) {
                            ws.send(JSON.stringify({
                                type: 'ERROR',
                                message: 'Room not found'
                            }));
                            return;
                        }
                        // Restore room from database
                        const restoredRoom = {
                            id: dbRoom.id,
                            code: dbRoom.code,
                            players: dbRoom.players.map(p => ({
                                id: p.id,
                                name: p.name,
                                position: 0,
                                color: p.color
                            })),
                            currentTurn: 0,
                            gameState: dbRoom.status === 'inactive' ? 'waiting' : dbRoom.status,
                            snakesAndLadders: createSnakesAndLadders(),
                            boardSize: 100,
                            winner: dbRoom.winnerId
                        };
                        // Update player connection if valid incomingPlayerId exists in room
                        if (incomingPlayerId && restoredRoom.players.some(p => p.id === incomingPlayerId)) {
                            playerId = incomingPlayerId; // Set connection's playerId
                            currentRoomId = dbRoom.id;
                            playerConnections.set(incomingPlayerId, ws);
                        }
                        // Send room state
                        ws.send(JSON.stringify({
                            type: 'ROOM_STATE',
                            room: restoredRoom
                        }));
                        activeGames.set(dbRoom.id, restoredRoom);
                        if (dbRoom.status === 'inactive') {
                            yield prisma.gameRoom.update({
                                where: { id: dbRoom.id },
                                data: { status: 'waiting' }
                            });
                        }
                    }
                    else {
                        // Room is already in memory
                        const [roomId, room] = roomEntry;
                        // Update player connection if valid incomingPlayerId exists in room
                        if (incomingPlayerId && room.players.some(p => p.id === incomingPlayerId)) {
                            playerId = incomingPlayerId; // Set connection's playerId
                            currentRoomId = roomId;
                            playerConnections.set(incomingPlayerId, ws);
                        }
                        // Send room state
                        ws.send(JSON.stringify({
                            type: 'ROOM_STATE',
                            room
                        }));
                    }
                    break;
                }
                case 'JOIN_ROOM': {
                    const { roomCode, playerName, color } = data;
                    const roomEntry = Array.from(activeGames.entries())
                        .find(([_, room]) => room.code === roomCode);
                    if (!roomEntry) {
                        const dbRoom = yield prisma.gameRoom.findFirst({
                            where: { code: roomCode, status: 'waiting' },
                            include: { players: true }
                        });
                        if (!dbRoom) {
                            ws.send(JSON.stringify({
                                type: 'ERROR',
                                message: 'Room not found'
                            }));
                            return;
                        }
                        const restoredRoom = {
                            id: dbRoom.id,
                            code: dbRoom.code,
                            players: dbRoom.players.map(p => ({
                                id: p.id,
                                name: p.name,
                                position: 0,
                                color: p.color
                            })),
                            currentTurn: 0,
                            gameState: dbRoom.status,
                            snakesAndLadders: createSnakesAndLadders(),
                            boardSize: 100,
                            winner: null
                        };
                        activeGames.set(dbRoom.id, restoredRoom);
                        playerId = (0, crypto_1.randomUUID)();
                        const player = {
                            id: playerId,
                            name: playerName,
                            position: 0,
                            color: color || '#' + Math.floor(Math.random() * 16777215).toString(16)
                        };
                        restoredRoom.players.push(player);
                        playerConnections.set(playerId, ws);
                        currentRoomId = dbRoom.id;
                        yield prisma.player.create({
                            data: {
                                id: playerId,
                                name: player.name,
                                color: player.color,
                                gameRoomId: dbRoom.id
                            }
                        });
                        broadcastToRoom(currentRoomId, {
                            type: 'PLAYER_JOINED',
                            player,
                            roomState: restoredRoom
                        });
                        ws.send(JSON.stringify({
                            type: 'ROOM_JOINED',
                            room: restoredRoom,
                            playerId
                        }));
                    }
                    else {
                        const [roomId, room] = roomEntry;
                        if (room.gameState !== 'waiting') {
                            ws.send(JSON.stringify({
                                type: 'ERROR',
                                message: 'Game already started'
                            }));
                            return;
                        }
                        playerId = (0, crypto_1.randomUUID)();
                        const player = {
                            id: playerId,
                            name: playerName,
                            position: 0,
                            color: color || '#' + Math.floor(Math.random() * 16777215).toString(16)
                        };
                        room.players.push(player);
                        playerConnections.set(playerId, ws);
                        currentRoomId = roomId;
                        yield prisma.player.create({
                            data: {
                                id: playerId,
                                name: player.name,
                                color: player.color,
                                gameRoomId: roomId
                            }
                        });
                        broadcastToRoom(roomId, {
                            type: 'PLAYER_JOINED',
                            player,
                            roomState: room
                        });
                        ws.send(JSON.stringify({
                            type: 'ROOM_JOINED',
                            room,
                            playerId
                        }));
                    }
                    break;
                }
                case 'START_GAME': {
                    if (!currentRoomId)
                        return;
                    const room = activeGames.get(currentRoomId);
                    if (!room)
                        return;
                    if (room.players.length < 2) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: 'Need at least 2 players to start'
                        }));
                        return;
                    }
                    room.gameState = 'playing';
                    yield prisma.gameRoom.update({
                        where: { id: currentRoomId },
                        data: { status: 'playing' }
                    });
                    broadcastToRoom(currentRoomId, {
                        type: 'GAME_STARTED',
                        roomState: room
                    });
                    break;
                }
                case 'ROLL_DICE': {
                    if (!currentRoomId || !playerId) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: 'Invalid session state'
                        }));
                        return;
                    }
                    const room = activeGames.get(currentRoomId);
                    if (!room || room.gameState !== 'playing') {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: 'Game not in playing state'
                        }));
                        return;
                    }
                    // Find player index by ID
                    const playerIndex = room.players.findIndex(p => p.id === playerId);
                    // Check if it's this player's turn
                    if (playerIndex === -1) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: 'Player not found in game'
                        }));
                        return;
                    }
                    if (playerIndex !== room.currentTurn) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: 'Not your turn'
                        }));
                        return;
                    }
                    // Roll the dice
                    const diceValue = Math.floor(Math.random() * 6) + 1;
                    const player = room.players[playerIndex];
                    // Calculate new position
                    let newPosition = player.position + diceValue;
                    // Check for snakes and ladders
                    if (room.snakesAndLadders[newPosition]) {
                        newPosition = room.snakesAndLadders[newPosition];
                    }
                    // Check for win condition
                    if (newPosition >= room.boardSize) {
                        newPosition = room.boardSize;
                        room.gameState = 'finished';
                        room.winner = player.id;
                        // Update database
                        yield prisma.gameRoom.update({
                            where: { id: currentRoomId },
                            data: {
                                status: 'finished',
                                winnerId: player.id
                            }
                        });
                    }
                    // Update player position
                    player.position = newPosition;
                    // Move to next player's turn
                    room.currentTurn = (room.currentTurn + 1) % room.players.length;
                    // Broadcast the move to all players
                    broadcastToRoom(currentRoomId, {
                        type: 'PLAYER_MOVED',
                        playerId: player.id,
                        diceValue,
                        newPosition,
                        nextTurn: room.currentTurn,
                        gameState: room.gameState,
                        winner: room.winner
                    });
                    break;
                }
                case 'RESET_GAME': {
                    if (!currentRoomId)
                        return;
                    const room = activeGames.get(currentRoomId);
                    if (!room)
                        return;
                    room.players.forEach(p => p.position = 0);
                    room.currentTurn = 0;
                    room.gameState = 'playing';
                    room.winner = null;
                    yield prisma.gameRoom.update({
                        where: { id: currentRoomId },
                        data: {
                            status: 'playing',
                            winnerId: null
                        }
                    });
                    broadcastToRoom(currentRoomId, {
                        type: 'GAME_RESET',
                        roomState: room
                    });
                    break;
                }
            }
        }
        catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: 'Error processing request'
            }));
        }
    }));
    ws.on('close', () => __awaiter(void 0, void 0, void 0, function* () {
        if (playerId && currentRoomId) {
            const room = activeGames.get(currentRoomId);
            if (room) {
                const playerIndex = room.players.findIndex(p => p.id === playerId);
                if (playerIndex !== -1) {
                    room.players.splice(playerIndex, 1);
                    if (room.players.length === 0) {
                        activeGames.delete(currentRoomId);
                        yield prisma.gameRoom.update({
                            where: { id: currentRoomId },
                            data: { status: 'inactive' }
                        });
                    }
                    else {
                        if (playerIndex < room.currentTurn) {
                            room.currentTurn--;
                        }
                        else if (playerIndex === room.currentTurn) {
                            room.currentTurn %= room.players.length;
                        }
                        broadcastToRoom(currentRoomId, {
                            type: 'PLAYER_LEFT',
                            playerId,
                            roomState: room
                        });
                    }
                }
            }
            playerConnections.delete(playerId);
        }
    }));
});
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
