import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { getColor } from '../../../config/bot.js';
import { logEvent } from '../../../utils/moderation.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { sanitizeInput } from '../../../utils/validation.js';

export default {
    name: 'say_modal',
    async execute(interaction, client, args) {
        const [channelId, asEmbedFlag] = args;
        const channel = interaction.guild.channels.cache.get(channelId) || interaction.channel;

        const rawTitle = interaction.fields.getTextInputValue('say_title');
        const rawMessage = interaction.fields.getTextInputValue('say_message');

        const message = sanitizeInput(rawMessage, 4096);
        const asEmbed = asEmbedFlag === '1';

        if (!message) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'Message cannot be empty.',
            });
        }

        const memberPermissions = channel.permissionsFor(interaction.member);
        const botPermissions = channel.permissionsFor(interaction.guild.members.me);

        if (!memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `You do not have permission to send messages in ${channel}.`,
            });
        }

        if (!botPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `I do not have permission to send messages in ${channel}.`,
            });
        }

        let payload = {};
        if (asEmbed) {
            const embed = new EmbedBuilder()
                .setColor(getColor('primary') || '#5865F2')
                .setDescription(message);

            if (rawTitle) {
                const title = sanitizeInput(rawTitle, 256);
                if (title) embed.setTitle(title);
            }

            payload = { embeds: [embed] };
        } else {
            payload = { content: message };
        }

        const sentMessage = await channel.send(payload);

        await logEvent({
            client,
            guild: interaction.guild,
            event: {
                action: 'Bot Message Sent',
                target: `${channel} (${channel.id})`,
                executor: `${interaction.user.tag} (${interaction.user.id})`,
                reason: message.length > 200 ? `${message.slice(0, 197)}...` : message,
                metadata: {
                    channelId: channel.id,
                    messageId: sentMessage.id,
                    moderatorId: interaction.user.id,
                    messageLength: message.length,
                },
            },
        });

        await interaction.reply({
            embeds: [
                successEmbed(
                    'Message Sent',
                    `Posted in ${channel}. [Jump to message](${sentMessage.url})`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
