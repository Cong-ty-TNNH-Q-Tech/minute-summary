const {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const state = require('./utils/state.js');
const keyManager = require('./utils/keyManager.js');

require('dotenv').config();
keyManager.init();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

//? Load commands to collection
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith('.js'));

for(const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if('data' in command && 'execute' in command)
    client.commands.set(command.data.name, command);
  else
    console.log(
      `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
    );
}

//? Sync commands with the server
const rest = new REST().setToken(process.env.TOKEN);
const commands = Array.from(client.commands.values()).map((value) =>
  value.data.toJSON()
);

(async () => {
  try {
    console.log(
      `Started refreshing ${commands.length} application (/) commands.`
    );

    const data = await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log(
      `Successfully reloaded ${data.length} application (/) commands.`
    );
  } catch(error) {
    console.error(error);
  }
})();

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

//? Load available meetings
const MEETINGS_DIR = path.join(__dirname, '..', 'meetings/');
if(!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR);

const files = fs.readdirSync(MEETINGS_DIR);
const directories = files.filter((file) =>
  fs.statSync(path.join(MEETINGS_DIR, file)).isDirectory()
);

state.meetings = directories.map((dir) => {
  const meetingPath = path.join(MEETINGS_DIR, dir);
  const meetingFiles = fs.readdirSync(meetingPath);

  return {
    name: dir,
    recorded: meetingFiles.some(
      (file) => file.endsWith('.mp3') || file.endsWith('.ogg')
    ),
    transcribed: meetingFiles.some((file) => file.endsWith('.txt')),
    summarized: meetingFiles.some((file) => file.endsWith('.md')),
  };
});

//? Handle commands and autocompletions
client.on(Events.InteractionCreate, async (interaction) => {
  if(interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);

    if(!command) {
      console.error(`Brak komendy: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch(error) {
      console.error(error);
    }
  } else if(interaction.isAutocomplete()) {
    const command = interaction.client.commands.get(interaction.commandName);

    if(!command) {
      console.error(
        `No command matching ${interaction.commandName} was found.`
      );
      return;
    }

    try {
      await command.autocomplete(interaction);
    } catch(error) {
      console.error(error);
    }
  }
});

client.login(process.env.TOKEN);