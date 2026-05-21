const djsv = require('@discordjs/voice');
const { MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const prism = require('prism-media');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { PassThrough } = require('stream');
const AsyncLock = require('async-lock');
const config = require('config');
const { cleanupRecording } = require('../../utils/utils');
const embeds = require('../../utils/embeds');
const state = require('../../utils/state');

const stateLock = new AsyncLock();

const MEETINGS_DIR = path.join(__dirname, '../../../meetings/');
const AUDIO_SETTINGS = {
  channels: 1,
  rate: 48000,
  frameSize: 960,
  bitrate: '64k',
  mixInterval: 20,
};

module.exports = {
  async execute(interaction) {
    const memberRoles = interaction.member.roles.cache.map((role) => role.name);
    const hasPermission = memberRoles.some((role) =>
      config.get('allowed_roles').includes(role)
    );

    if(!hasPermission)
      return await interaction.reply({
        embeds: [embeds.noPermissionEmbed],
        flags: MessageFlags.Ephemeral,
      });

    if(interaction.channel.isThread()) 
      return await interaction.reply({
        embeds: [embeds.threadEmbed],
        flags: MessageFlags.Ephemeral,
      });

    await stateLock.acquire('recording', async () => {
      if(state.currentMeeting)
        return await interaction.reply({
          embeds: [embeds.recordingAlreadyStartedEmbed],
          flags: MessageFlags.Ephemeral,
        });

      const meetingName = interaction.options.getString('name');

      if(state.meetings.map((m) => m.name).includes(meetingName))
        return await interaction.reply({
          embeds: [embeds.meetingAlreadyExistsEmbed],
          flags: MessageFlags.Ephemeral,
        });

      const voiceChannel = interaction.member.voice.channel;
      if(!voiceChannel)
        return await interaction.reply({
          embeds: [embeds.noVoiceChannelEmbed],
          flags: MessageFlags.Ephemeral,
        });

      try {
        state.connection = djsv.joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: true,
        });

        if(!state.connection)
          return await interaction.reply({
            embeds: [embeds.errorWhileRecordingEmbed],
          });

        state.connection.on('stateChange', (oldState, newState) => {
          console.log(`[VoiceConnection] ${oldState.status} → ${newState.status}`);
          if(newState.status === djsv.VoiceConnectionStatus.Disconnected && 
             oldState.status !== newState.status) {
            console.error('Unexpected disconnection!');
            cleanupRecording();
          }
        });

        state.currentMeeting = meetingName;
        await interaction.reply({ embeds: [embeds.recordingStartedEmbed(meetingName)] });

        const meetingFolder = path.join(MEETINGS_DIR, state.currentMeeting);
        if(!fs.existsSync(meetingFolder)) fs.mkdirSync(meetingFolder);

        const oggPath = path.join(meetingFolder, `${state.currentMeeting}.ogg`);
        state.recordingProcess = spawn(ffmpeg, [
          '-f', 's16le',
          '-ar', AUDIO_SETTINGS.rate.toString(),
          '-ac', AUDIO_SETTINGS.channels.toString(),
          '-i', 'pipe:0',
          '-c:a', 'libopus',
          '-b:a', AUDIO_SETTINGS.bitrate,
          '-application', 'voip',
          '-flush_packets', '1',
          '-vn', '-y',
          oggPath,
        ]);
        
        state.recordingProcess.on('error', (err) => {
          console.error('Recording process error: ', err);
          interaction.editReply({ embeds: [embeds.errorWhileRecordingEmbed] });
          state.connection.destroy();
          state.connection = null;
        });

        state.recordingProcess.on('close', async () => {
          if(!fs.existsSync(oggPath)) {
            console.error('OGG file does not exist');
            fs.rmSync(meetingFolder, { recursive: true });
            await interaction.editReply({ embeds: [embeds.errorWhileRecordingEmbed] });
          } else
            console.log('Recording saved successfully');
        });

        state.userBuffers = new Map();
        state.mixingInterval = setInterval(() => {
          const chunkSize = AUDIO_SETTINGS.rate * 2 * (AUDIO_SETTINGS.mixInterval / 1000);

          const users = Array.from(state.userBuffers.entries());
          if(users.length === 0) return;

          const userChunks = [];
          for(const [, user] of users) {
            const available = user.buffer.length - user.position;
            const bytesToRead = Math.min(available, chunkSize);
            let chunk;

            if(bytesToRead > 0) {
              chunk = user.buffer.subarray(user.position, user.position + bytesToRead);
              user.position += bytesToRead;
              if(user.position >= user.buffer.length) {
                user.buffer = Buffer.alloc(0);
                user.position = 0;
              }
            } else
              chunk = Buffer.alloc(0);

            if(chunk.length < chunkSize) {
              const padding = Buffer.alloc(chunkSize - chunk.length);
              chunk = Buffer.concat([chunk, padding]);
            }

            userChunks.push(chunk);
          }

          const mixedBuffer = Buffer.alloc(chunkSize);
          const mixedSamples = new Int16Array(mixedBuffer.buffer, mixedBuffer.byteOffset, chunkSize / 2);
          mixedSamples.fill(0);

          for(const chunk of userChunks) {
            const userSamples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
            for(let i = 0; i < userSamples.length; i++) {
              const sum = mixedSamples[i] + userSamples[i];
              mixedSamples[i] = Math.max(-32768, Math.min(32767, sum));
            }
          }

          if(state.recordingProcess && !state.recordingProcess.stdin.destroyed)
            state.recordingProcess.stdin.write(mixedBuffer);
        }, AUDIO_SETTINGS.mixInterval);

        const receiver = state.connection.receiver;
        state.userStreams = new Map();

        receiver.speaking.on('start', (userId) => {
          console.log(`[Recording] Speaking START detected for user: ${userId}`);
          if(state.userStreams.has(userId)) return;

          const opusDecoder = new prism.opus.Decoder({
            rate: AUDIO_SETTINGS.rate,
            channels: AUDIO_SETTINGS.channels,
            frameSize: AUDIO_SETTINGS.frameSize,
          });

          const audioStream = receiver.subscribe(userId, {
            end: {
              behavior: djsv.EndBehaviorType.AfterSilence,
              duration: 200,
            },
          });

          const pcmStream = new PassThrough();

          let firstPacketLogged = false;
          audioStream.on('data', (chunk) => {
            if(!firstPacketLogged) {
              console.log(`[Debug] First audio packet: ${chunk.length} bytes | hex: ${chunk.slice(0, 16).toString('hex')}`);
              firstPacketLogged = true;
            }
          });

          audioStream.pipe(opusDecoder).pipe(pcmStream);

          opusDecoder.on('error', (err) => {
            console.warn(`[Recording] Opus decode error for user ${userId} (skipping): ${err.message}`);
          });

          audioStream.on('error', (err) => {
            console.warn(`[Recording] Audio stream error for user ${userId}: ${err.message}`);
          });

          state.userBuffers.set(userId, { buffer: Buffer.alloc(0), position: 0 });

          let bytesReceived = 0;
          pcmStream.on('data', (chunk) => {
            const user = state.userBuffers.get(userId);
            user.buffer = Buffer.concat([user.buffer, chunk]);
            bytesReceived += chunk.length;
          });

          state.userStreams.set(userId, {
            audioStream,
            opusDecoder,
            pcmStream,
          });
        });

        receiver.speaking.on('end', (userId) => {
          console.log(`[Recording] Speaking END detected for user: ${userId}`);
          const streamInfo = state.userStreams.get(userId);
          if(streamInfo) {
            console.log(`[Recording] Bytes received from user ${userId}: ${streamInfo.bytesReceived || 0}`);
            streamInfo.audioStream.destroy();
            streamInfo.opusDecoder.destroy();
            streamInfo.pcmStream.destroy();
            state.userBuffers.delete(userId);
            state.userStreams.delete(userId);
          }
        });
      } catch(error) {
        console.error('Meeting start error:', error);

        if(state.connection) {
          state.connection.destroy();
          state.connection = null;
        }

        if(state.mixingInterval) {
          clearInterval(state.mixingInterval);
          state.mixingInterval = null;
        }

        if(state.recordingProcess) {
          state.recordingProcess.kill('SIGKILL');
          state.recordingProcess = null;
        }

        state.currentMeeting = null;
        state.userBuffers = null;
        state.userStreams = null;
        await interaction.editReply({ embeds: [embeds.errorWhileRecordingEmbed] });
      }
    });
  },
};