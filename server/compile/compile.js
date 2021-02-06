const shell = require('shelljs');
const fs = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const debug = require('debug')('compile');

const { switchToBranch } = require('../git/git');
const {
  tasmotaRepo,
  userConfigOvewrite,
  tasmotaVersionFile,
  userPlatformioOverrideIni,
} = require('../config/config');

// Since 6.7.1.1 there is no sonoff src dir. New dir is tasmota
// if we switch to "old" branch with sonoff dir rename that dir to new name
const createNewTasmotaStructure = () => {
  const oldPath = path.resolve(tasmotaRepo, 'sonoff');
  const newPath = path.resolve(tasmotaRepo, 'tasmota');
  const isOldStructure = fs.pathExistsSync(oldPath);

  if (isOldStructure) {
    try {
      fs.moveSync(oldPath, newPath, { overwrite: true });
    } catch (e) {
      throw new Error(`Cannot create new Tasmota structure: ${e}`);
    }
  }
};

const getTasmotaVersion = () => {
  const fileExists = fs.pathExistsSync(tasmotaVersionFile);
  const versRegexp = /const uint32_t VERSION = (.*);/gm;

  if (fileExists) {
    const file = fs.readFileSync(tasmotaVersionFile, {
      encoding: 'utf8',
      flag: 'r',
    });
    const match = [...file.matchAll(versRegexp)];
    if (match[0]) {
      return parseInt(match[0][1]);
    } else {
      throw new Error(`Cannot find Tasmota version in ${tasmotaVersionFile}.`);
    }
  } else {
    throw new Error(`${tasmotaVersionFile} does not exists.`);
  }
};

const createUserDefines = (data) => {
  let userDefines = [];
  Object.keys(data).forEach((e) => {
    // only uppercase keys are those which are important to place in user_config_overwrite.h
    // lowercase keys are 'helpers'
    const f = e[0].toLowerCase();
    if (f !== e[0]) {
      if (data[e] === true) {
        userDefines.push(
          `#ifdef ${e}\n  #undef ${e}\n#endif\n#define ${e}\n\n`
        );
        return;
      }
      if (data[e] === false) {
        userDefines.push(`#ifdef ${e}\n  #undef ${e}\n#endif\n\n`);
        return;
      }
      if (data[e] !== '') {
        console.log('TUTAJ', e, data[e]);
        if (
          [
            'STA_PASS1',
            'STA_SSID1',
            'WIFI_DNS',
            'WIFI_GATEWAY',
            'WIFI_IP_ADDRESS',
            'WIFI_SUBNETMASK',
          ].includes(e)
        ) {
          userDefines.push(
            `#ifdef ${e}\n  #undef ${e}\n#endif\n#define ${e}\t"${data[e]}"\n\n`
          );
        } else {
          userDefines.push(
            `#ifdef ${e}\n  #undef ${e}\n#endif\n#define ${e}\t${data[e]}\n\n`
          );
        }
      }
    }
  });

  return userDefines;
};

const getFeaturePlatformioEntries = (data) => {
  let platformioEntries = {};

  Object.keys(data).forEach((e) => {
    if (e.includes('platformio_entries#')) {
      if (data[e].build_flags) {
        platformioEntries.build_flags = platformioEntries.build_flags
          ? `${platformioEntries.build_flags} ${data[e].build_flags}`
          : `${data[e].build_flags}`;
      }
    }
  });

  return platformioEntries;
};

const prepareFiles = async (data) => {
  const { network, features, version, customParams } = data;
  await switchToBranch(data.version.tasmotaVersion);

  // user_config_override.h file
  const userDefinesNetwork = createUserDefines(network);
  const userDefinesFeatures = createUserDefines(features);
  const userDefinesBoard = createUserDefines(features.board.defines);
  const userDefinesVersion = createUserDefines(version);
  const outputOverwrites =
    '#ifndef _USER_CONFIG_OVERRIDE_H_\n' +
    '#define _USER_CONFIG_OVERRIDE_H_\n\n' +
    '#warning **** user_config_override.h: Using Settings from this File ****\n\n' +
    `${userDefinesNetwork.join('')}` +
    `${userDefinesFeatures.join('')}` +
    `${userDefinesBoard.join('')}` +
    `${userDefinesVersion.join('')}` +
    `${customParams}\n` +
    '#endif\n';

  try {
    await fs.writeFile(userConfigOvewrite, outputOverwrites);
    debug(`Successfully write ${userConfigOvewrite}`);
  } catch (e) {
    throw new Error(`Cannot write to ${userConfigOvewrite}: ${e}`);
  }

  // platformio.ini file
  const featurePlatformioEntries = getFeaturePlatformioEntries(features);

  const commonBuildFlags = features.board.name.includes('esp32')
    ? '${common32.build_flags}'
    : '${common.build_flags}';

  const { platformio_entries } = features.board;

  Object.keys(featurePlatformioEntries).forEach((e) => {
    if (platformio_entries[e]) {
      platformio_entries[
        e
      ] = `${platformio_entries[e]} ${featurePlatformioEntries[e]}`;
    } else {
      platformio_entries[e] = `${featurePlatformioEntries[e]}`;
    }

    if (
      e === 'build_flags' &&
      !platformio_entries[e].includes(commonBuildFlags)
    ) {
      platformio_entries[e] = `${commonBuildFlags} ${platformio_entries[e]}`;
    }
  });

  const platformioEnvCustom = Object.keys(platformio_entries)
    .map((e) => `${e} = ${platformio_entries[e]}`)
    .join('\n');
  const platformioContent =
    '[platformio]\n' +
    `default_envs = firmware\n\n` +
    `[env:firmware]\n` +
    `${platformioEnvCustom}\n`;

  try {
    await fs.writeFileSync(userPlatformioOverrideIni, platformioContent);
  } catch (e) {
    throw new Error(
      `Cannot write new content to ${userPlatformioOverrideIni} file\n${e}\n`
    );
  }
};

const compileCode = (socket, data) => {
  prepareFiles(data)
    .then((prepared) => {
      const cdRet = shell.cd(tasmotaRepo);
      let outputMessages = [];
      const MESSAGE_BUFFER_SIZE = 5;

      if (cdRet.code !== 0) {
        socket.emit('message', cdRet.stderr);
        socket.emit('finished', { status: cdRet.code, message: cdRet.stderr });
        debug(cdRet.stderr);
        return;
      }

      const child = shell.exec('pio run', { silent: true, async: true });

      child.on('exit', (code, signal) => {
        const message = `Finished. Exit code: ${code}.\n`;
        socket.emit('message', outputMessages.join(''));
        socket.emit('message', message);
        socket.emit('finished', { ok: code === 0 });
        debug(message);
      });

      child.stderr.on('data', (stderrData) => {
        outputMessages.push(stderrData);
        if (outputMessages.length > MESSAGE_BUFFER_SIZE) {
          socket.emit('message', outputMessages.join(''));
          outputMessages = [];
        }
        debug(stderrData);
      });

      child.stdout.on('data', (stdoutData) => {
        outputMessages.push(stdoutData);
        if (outputMessages.length > MESSAGE_BUFFER_SIZE) {
          socket.emit('message', outputMessages.join(''));
          outputMessages = [];
        }
        debug(stdoutData);
      });
    })
    .catch((e) => {
      socket.emit('message', e.message);
      socket.emit('finished', { ok: false });
      debug(e);
    });
};

module.exports = { compileCode };
