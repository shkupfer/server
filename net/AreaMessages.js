"use strict";
const createLogger = require('logging').default;
const logger = createLogger('AreaMessages');

const Areas = require('../global/Areas.js');
const Stats = require('../global/Stats.js');

server.handleMessage('get_population', async (client, args) => {
    const areaId = args.area;
    if (areaId === undefined) {
        logger.warn('Got get_population message without area id!  Ignoring.');
        return;
    }

    let population = 0;
    if (areaId in Areas.Groups) {
        for (const area of Areas.Groups[areaId]) {
            const users = await redis.getUserIdsInArea(area, client.game);
            population += users.length;
        }
    } else {
        population = (await redis.getUserIdsInArea(areaId, client.game)).length;
    }
    client.send('population_resp', {area: areaId, population: population});

});

server.handleMessage('enter_area', async (client, args) => {
    const areaId = args.area;
    if (areaId === undefined) {
        logger.warn('Got enter_area message without area id!  Ignoring.');
        return;
    }
    if (areaId == 33) {
        // HACK
        return;
    }
    client.areaId = areaId;
    await redis.addUserToArea(client.userId, areaId, client.game);
});

server.handleMessage('leave_area', async (client, args) => {
    if (!client.areaId) {
        // this.logger.error("Got leave_area without being in an area!");
        return;
    }
    const oldAreaId = client.areaId;
    client.areaId = 0;
    client.sliceStart = 0;
    client.sliceEnd = 0;
    await redis.removeUserFromArea(client.userId, oldAreaId, client.game);
});

server.handleMessage('get_players', async (client, args) => {
    const start = args.start;
    const end = args.end + 1;

    if (!client.areaId) {
        logger.warn("Got get_players without being in an area!");
        return;
    }

    client.sliceStart = start;
    client.sliceEnd = end;

    const users = await redis.getUsersInArea(client.areaId, client.game);

    const players = [];
    for (const user of users) {
        if (user.id == client.userId) {
            // Don't add ourselves in.
            continue;
        }
        // TODO: Fix this
        players.push([user.user, user.id, user.icon, 0, 0, 0, user.phone, user.opponent]);
    }
    client.send('players_list', {players: players.slice(client.sliceStart, client.sliceEnd)});

});

process.on('update_players_list', (args) => {
    const areaId = args.area;
    const game = args.game;
    const users = args.users;

    for (const client of server.connections) {
        if (client.areaId == areaId && client.game == game) {
            const players = [];
            for (const user of users) {
                if (user.id == client.userId) {
                    // Don't add ourselves in.
                    continue;
                }
                // TODO: Fix this
                players.push([user.user, user.id, user.icon, 0, 0, 0, user.phone, user.opponent]);
            }
            client.send('players_list', {players: players.slice(client.sliceStart, client.sliceEnd)});
        }
    }
});

server.handleMessage('game_started', async (client, args) => {
    logger.info("GAME STARTED " + client.userId + " " + args.user);
    const playerId = args.user;

    await redis.setInGame(client.userId, 1);
    await redis.setInGame(playerId, 1);

    await redis.sendUsersInArea(client.areaId, client.game);
    await redis.sendGamesPlayingInArea(client.areaId, client.game);
    await redis.removeOngoingResults(client.userId, client.game);
    await redis.removeOngoingResults(playerId, client.game);
});

server.handleMessage('game_finished', async (client, args) => {
    logger.info("GAME FINISHED " + client.userId + " vs. " + client.opponentId);
    await redis.sendGamesPlayingInArea(client.areaId, client.game);
    const user = await redis.getUserById(client.userId, client.game);
    if (user.inGame) {
        logger.info("USER " + client.userId + " IS IN GAME");
        await redis.setInGame(client.userId, 0);
        if (await redis.hasOngoingResults(client.userId, client.game)) {
            logger.info("HAS ONGOING RESULTS");
            // Get the most recent results data
            const finalResultsAsStrings = await redis.getOngoingResults(client.userId, client.game);
            await redis.removeOngoingResults(client.userId, client.game);
            const finalResults = Object.fromEntries(
                Object.entries(finalResultsAsStrings).map(([k, stat]) => [k, Number(stat)])
            );
            // Get this user's existing stats
            const statsStrings = await redis.getStats(client.userId, client.game);
            let stats = Object.fromEntries(
                Object.entries(statsStrings).map(([k, stat]) => [k, Number(stat)])
            );
            // Calculate updated stats
            stats = Stats.Aggregators[client.game](finalResults, stats);

            await redis.setStats(client.userId, client.game, stats);
        }
    }
});

process.on('update_games_playing', async (args) => {
    const areaId = args.area;
    const game = args.game;
    const gamesPlaying = args.games;

    for (const client of server.connections) {
        if (client.areaId == areaId && client.game == game) {
            client.send('games_playing', {games: gamesPlaying});
        }
    }
});
