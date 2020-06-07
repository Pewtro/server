import Express from 'express';
import Sequelize from 'sequelize';
import * as Sentry from '@sentry/node';
import { StatusCodeError } from 'request-promise-native/errors';

import BlizzardApi, { getFactionFromType } from 'helpers/BlizzardApi';
import RegionNotSupportedError from 'helpers/RegionNotSupportedError';

import models from '/models';

const Guild = models.Guild;

/**
 * Handle requests for guild information and returns data from the Blizzard API.
 * The caching strategy being used here is to always return cached data first if it exists. then refresh in the background
 */
function sendJson(res, json) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(json);
}

function send404(res) {
  res.sendStatus(404);
}

async function getGuildFromBlizzardApi(region, realm, name) {
  const guildResponse = await BlizzardApi.fetchGuild(region, realm, name);
  const guildData = JSON.parse(guildResponse);
  if (!guildData) {
    throw new Error('Invalid guild response received');
  }
  let crest = guildData.crest; // Just some shorthand
  return {
    id: guildData.id,
    region: region.toLowerCase(),
    /* TODO I want to store the "true" realm & guild name given back by the API, but my gut says that this might break
      the `where` clause in getStoredGuild. A lot of potential character case switching and different character encoding?
     */
    realm: realm,
    name: name,
    faction: getFactionFromType(guildData.faction.type),
    created: guildData.created_timestamp,
    achievementPoints: guildData.achievement_points,
    memberCount: guildData.member_count,
    crest: {
      emblemId: crest.emblem.id,
      emblemColor: [crest.emblem.color.r, crest.emblem.color.g, crest.emblem.color.b, crest.emblem.color.a],
      borderId: crest.border.id,
      borderColor: [crest.border.color.r, crest.border.color.g, crest.border.color.b, crest.border.color.a],
      backgroundColor: [crest.background.color.r, crest.background.color.g, crest.background.color.b, crest.background.color.a],
    }
  }
}

async function getStoredGuild(realm, region, name) {
  if (realm && name && region) {
    return Guild.findOne({
      where: {
        name,
        region,
        realm,
      },
    });
  }
  return null;
}

async function storeGuild(guild) {
  await Guild.upsert({
    ...guild,
    updatedAt: Sequelize.fn('NOW'),
  });
}

async function fetchGuild(region, realm, name, res = null) {
  try {
    const guildFromApi = await getGuildFromBlizzardApi(region, realm, name);
    if (res) {
      sendJson(res, guildFromApi);
    }
    storeGuild(guildFromApi);
  } catch (error) {
    const body = error.response ? error.response.body : null;

    // We can't currently support the CN region because of Blizzard API restrictions
    if (error instanceof RegionNotSupportedError) {
      // Record the error because we want to know how often this occurs and if it breaks anything
      Sentry.captureException(error);
      if (res) {
        res.status(500);
        sendJson(res, {
          error: 'This region is not supported',
        });
      }
      return;
    }

    // Handle 404: guild not found errors.
    if (error instanceof StatusCodeError) {
      // We check for the text so this doesn't silently break when the API endpoint changes.
      const isGuildNotFoundError = error.statusCode === 404 && body && body.includes('Not found');
      if (isGuildNotFoundError) {
        if (res) {
          send404(res);
        }
        return;
      }
    }

    // Everything else is unexpected
    Sentry.captureException(error);
    if (res) {
      res.status(error.statusCode || 500);
      sendJson(res, {
        error: 'Blizzard API error',
        message: body || error.message,
      });
    }
  }
}

function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}

const router = Express.Router();
router.get('/i/guild/:region([A-Z]{2})/:realm([^/]{2,})/:name([^/]{2,})', cors, async (req, res) => {
  const {region, realm, name} = req.params;
  const storedGuild = await getStoredGuild(realm, region, name)

  let responded = false;
  if (storedGuild) {
    sendJson(res, storedGuild);
    responded = true;
  }
  fetchGuild(region, realm, name, !responded ? res : null)
});

export default router;
