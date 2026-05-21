const path = require('path');
const fs = require('fs');
const AsyncLock = require('async-lock');
const { MessageFlags } = require('discord.js');
const config = require('config');
const utils = require('../../utils/utils');
const embeds = require('../../utils/embeds');
const state = require('../../utils/state');

const stateLock = new AsyncLock();

const MEETINGS_DIR = path.join(__dirname, '../../../meetings/');

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

    await stateLock.acquire('recording', async () => {
      if(!state.recordingProcess || !state.connection)
        return await interaction.reply({
          embeds: [embeds.noActiveRecordingEmbed],
          flags: MessageFlags.Ephemeral,
        });

      try {
        console.log('Stopping connection and cleaning up resources...');

        await interaction.reply({ embeds: [embeds.processingAudioEmbed] });
        await utils.cleanupRecording();

        const meetingName = state.currentMeeting;
        state.currentMeeting = null;

        const meetingPath = path.join(MEETINGS_DIR, meetingName);

        const oggPath = path.join(meetingPath, `${meetingName}.ogg`);
        const mp3Path = path.join(meetingPath, `${meetingName}.mp3`);

        console.log(`Checking if OGG file exists at: ${oggPath}`);
        if(!fs.existsSync(oggPath)) {
          console.error('OGG file not found!');
          await interaction.editReply({ embeds: [embeds.errorWhileRecordingEmbed] });
          return;
        }

        state.meetings.push({
          name: meetingName,
          recorded: true,
          transcribed: false,
          summarized: false,
        });

        await interaction.editReply({ embeds: [embeds.recordingStoppedEmbed] });
        const message = await interaction.fetchReply();
        const thread = await message.startThread({
          name: `Summary of the meeting '${meetingName}'`,
        });

        console.log('Converting OGG to MP3...');
        const msg1 = await thread.send({ embeds: [embeds.convertingStartedEmbed] });
        try {
          await utils.convertOggToMp3(oggPath, mp3Path);
          await msg1.edit({ embeds: [embeds.convertingSuccessEmbed] });
        } catch(err) {
          console.error('Error converting OGG to MP3: ', err);
          await msg1.edit({ embeds: [embeds.convertingFailedEmbed] });
          throw new Error('Conversion failed');
        }

        console.log('Starting audio splitting...');
        const msg2 = await thread.send({ embeds: [embeds.splittingStartedEmbed] });
        let audioParts;
        try {
          audioParts = await utils.splitAudioFile(mp3Path, config.get('openai.transcription_max_size_MB'));
          console.log(`Audio splitting successful. Parts: ${audioParts.length}`);
          await msg2.edit({
            embeds: [embeds.splittingSuccessEmbed(audioParts.length)],
          });
        } catch(err) {
          console.error('Error while splitting the file: ', err);
          await msg2.edit({ embeds: [embeds.splittingFailedEmbed] });
          throw new Error('Splitting failed');
        }

        console.log('Starting transcription...');
        const msg3 = await thread.send({ embeds: [embeds.transcriptionStartedEmbed] });
        let transcription, transcriptionFile;
        try {
          transcription = await utils.transcribe(audioParts);
          if(!transcription) {
            console.warn('No speech detected in recording.');
            await msg3.edit({ embeds: [embeds.noSpeechDetectedEmbed] });
            throw new Error('No speech detected');
          }

          console.log('Saving transcription to file...');
          transcriptionFile = path.join(meetingPath, `${meetingName}.txt`);
          fs.writeFileSync(transcriptionFile, transcription, {
            encoding: 'utf8',
          });
          await msg3.edit({ embeds: [embeds.transcriptionCompletedEmbed] });
        } catch(err) {
          console.error('Error during transcription: ', err);
          await msg3.edit({ embeds: [embeds.transcriptionFailedEmbed] });
          throw new Error('Transcription failed');
        }

        console.log('Starting summary generation...');
        const msg4 = await thread.send({ embeds: [embeds.summaryStartedEmbed] });
        let summary;
        try {
          summary = await utils.summarize(transcriptionFile, msg4);
          if(!summary) {
            console.error('Summary generation failed!');
            await msg4.edit({ embeds: [embeds.summaryFailedEmbed] });
            throw new Error('Summary failed');
          }

          console.log('Saving summary to file...');
          const summaryFile = path.join(meetingPath, `${meetingName}.md`);
          fs.writeFileSync(summaryFile, summary, { encoding: 'utf8' });
          await msg4.edit({ embeds: [embeds.summaryCompletedEmbed] });
        } catch(err) {
          console.error('Error during summary generation: ', err);
          await msg4.edit({ embeds: [embeds.summaryFailedEmbed] });
          throw new Error('Summary failed');
        }

        console.log('Sending summary to thread...');
        await utils.sendSummary(summary, thread);
        await interaction.editReply({ embeds: [embeds.processingSuccessEmbed] });
      } catch(error) {
        console.error('Stop command error:', error);
        await interaction.editReply({ embeds: [embeds.processingFailedEmbed(error.message)] });
      } finally {
        console.log('Cleaning up state...');
        state.connection = null;
        state.recordingProcess = null;
        state.userBuffers = null;
        state.userStreams = null;
        state.currentMeeting = null;
      }
    });
  },
};