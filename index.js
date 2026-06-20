import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import http from "http";

dotenv.config();

const pendingSupportUsers = new Set();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
);
const bot = new Telegraf(process.env.BOT_TOKEN);

const GROUP_ID = process.env.GROUP_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.GROUP_ID;
const MINI_APP_URL = process.env.MINI_APP_URL || "";
const CHANNEL_URL = process.env.CHANNEL_URL || "";

const GROUP_HQ = process.env.GROUP_HQ || "";
const GROUP_S_TEAM = process.env.GROUP_S_TEAM || "";
const GROUP_T_TEAM = process.env.GROUP_T_TEAM || "";
const GROUP_MAIN = process.env.GROUP_MAIN || "";

const GROUP_HQ_NAME = process.env.GROUP_HQ_NAME || "HQ";
const GROUP_S_TEAM_NAME = process.env.GROUP_S_TEAM_NAME || "S-Team";
const GROUP_T_TEAM_NAME = process.env.GROUP_T_TEAM_NAME || "T-Team";
const GROUP_MAIN_NAME = process.env.GROUP_MAIN_NAME || "Main";

const LOCAL_GROUPS = [
    { id: GROUP_HQ, name: GROUP_HQ_NAME },
    { id: GROUP_S_TEAM, name: GROUP_S_TEAM_NAME },
    { id: GROUP_T_TEAM, name: GROUP_T_TEAM_NAME },
].filter((g) => g.id);

const ALL_GROUPS = [
    ...LOCAL_GROUPS,
    { id: GROUP_MAIN, name: GROUP_MAIN_NAME },
].filter((g) => g.id);

const getGroupName = (chatId) => {
    const id = chatId.toString();
    if (id === GROUP_HQ) return GROUP_HQ_NAME;
    if (id === GROUP_S_TEAM) return GROUP_S_TEAM_NAME;
    if (id === GROUP_T_TEAM) return GROUP_T_TEAM_NAME;
    if (id === GROUP_MAIN) return GROUP_MAIN_NAME;
    return "Группа";
};

const getTopicLink = (chatId, threadId) => {
    const cleanChatId = chatId.toString().replace("-100", "");
    return `https://t.me/c/${cleanChatId}/${threadId}`;
};

const getMod = async (userId) => {
    try {
        const { data } = await supabase
            .from("moderator_tg")
            .select("*")
            .eq("idtg", userId)
            .maybeSingle();
        return data || null;
    } catch {
        return null;
    }
};

const getModDisplay = async (telegram, userId, fromUser) => {
    const mod = await getMod(userId);
    if (mod?.name) return mod.name;

    try {
        const member = await telegram.getChatMember(GROUP_ID, userId);
        if (member.custom_title) return member.custom_title;
        const u = member.user;
        return `${u.first_name} ${u.last_name || ""}`.trim();
    } catch {
        if (fromUser?.first_name) {
            return `${fromUser.first_name} ${fromUser.last_name || ""}`.trim();
        }
        return "Модератор";
    }
};

const isGroupAdmin = async (telegram, userId) => {
    try {
        const member = await telegram.getChatMember(GROUP_ID, userId);
        return ["administrator", "creator"].includes(member.status);
    } catch {
        return false;
    }
};

const getSenderRole = async (telegram, userId) => {
    const mod = await getMod(userId);
    const modRole = mod?.role || 0;
    const isAdmin = await isGroupAdmin(telegram, userId);
    return isAdmin ? Math.max(modRole, 6) : modRole;
};

const checkAccess = (senderRole, minRole) => {
    if (senderRole === 0) return "silent";
    if (senderRole < minRole) return "denied";
    return "ok";
};

const resolveTarget = (ctx, args) => {
    const reply = ctx.message?.reply_to_message;
    if (reply) {
        if (!reply.from || reply.from.is_bot) return null;
        return reply.from.id;
    }
    if (args && args[0]) {
        const id = parseInt(args[0]);
        if (!isNaN(id)) return id;
    }
    return null;
};

const trackBotMsg = async (threadId, msgId) => {
    try {
        const { data } = await supabase
            .from("tickets")
            .select("bot_topic_msg_ids")
            .eq("thread_id", threadId)
            .maybeSingle();
        if (!data) return;
        const ids = JSON.parse(data.bot_topic_msg_ids || "[]");
        ids.push(msgId);
        await supabase
            .from("tickets")
            .update({ bot_topic_msg_ids: JSON.stringify(ids) })
            .eq("thread_id", threadId);
    } catch {}
};

const cleanUpTicketData = async (telegram, ticket) => {
    try {
        const ids = JSON.parse(ticket.bot_topic_msg_ids || "[]");
        for (const id of ids) {
            await telegram.deleteMessage(GROUP_ID, id).catch(() => {});
        }
        await supabase
            .from("tickets")
            .update({ bot_topic_msg_ids: "[]" })
            .eq("thread_id", ticket.thread_id);

        if (ticket.admin_pm_msg_id && ticket.admin_pm_chat_id) {
            await telegram
                .deleteMessage(ticket.admin_pm_chat_id, ticket.admin_pm_msg_id)
                .catch(() => {});
        }
    } catch {}
};

const createNewTopic = async (ctx, userId, userName) => {
    const topicTitle = `${userName} [${userId}]`;
    const forumTopic = await ctx.telegram.createForumTopic(
        GROUP_ID,
        topicTitle,
    );
    const threadId = forumTopic.message_thread_id;

    const notifMsg = await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `*Тикет*\n${userName} (\`${userId}\`)\nСтатус: *не взят*`,
        {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("Взять тикет", `take_${threadId}`)],
            ]),
        },
    );

    const { error: insertError } = await supabase.from("tickets").insert({
        user_id: userId,
        thread_id: threadId,
        last_reply_by: "user",
        status: "open",
        assigned_to: null,
        assigned_name: null,
        notif_msg_id: notifMsg.message_id,
        bot_topic_msg_ids: "[]",
        admin_pm_msg_id: null,
        admin_pm_chat_id: null,
        updated_at: new Date().toISOString(),
    });

    if (insertError) {
        await ctx.telegram.closeForumTopic(GROUP_ID, threadId).catch(() => {});
        await ctx.reply("Произошла ошибка. Попробуйте позже.");
        return null;
    }

    return threadId;
};

const buildMainKeyboard = () => {
    const rows = [];
    if (MINI_APP_URL)
        rows.push([
            { text: "Открыть приложение", web_app: { url: MINI_APP_URL } },
        ]);
    if (CHANNEL_URL) rows.push([Markup.button.url("Наш канал", CHANNEL_URL)]);
    rows.push([
        Markup.button.callback("Написать в поддержку", "support_start"),
    ]);
    return Markup.inlineKeyboard(rows);
};

const sendMainMenu = async (ctx) => {
    await ctx.reply("Вас приветствует команда *MR* 👋\n\nВыберите действие:", {
        parse_mode: "Markdown",
        ...buildMainKeyboard(),
    });
};

const generateUniqueKey = async () => {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let attempt = 0; attempt < 10; attempt++) {
        let key = "";
        for (let i = 0; i < 15; i++) {
            key += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const { data } = await supabase
            .from("users")
            .select("id")
            .eq("key", key)
            .maybeSingle();
        if (!data) return key;
    }
    return null;
};

const registerUser = async (telegram, from) => {
    const userId = from.id;
    const username = from.username ? `@${from.username}` : "null";
    const fullName =
        `${from.first_name || ""} ${from.last_name || ""}`.trim() || null;

    try {
        const { data: existing, error: checkError } = await supabase
            .from("users")
            .select("id, avatar_url")
            .eq("idtg", userId)
            .maybeSingle();

        if (checkError && checkError.code !== "PGRST116") {
            console.error("registerUser check error:", checkError);
            return false;
        }

        let avatarUrl = null;
        try {
            const photos = await telegram.getUserProfilePhotos(userId, {
                limit: 1,
            });
            if (photos?.total_count > 0 && photos.photos?.length > 0) {
                const sizes = photos.photos[0];
                const fileId = sizes[sizes.length - 1].file_id;
                const file = await telegram.getFile(fileId);
                if (file?.file_path) {
                    avatarUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
                }
            }
        } catch {}

        if (existing) {
            if (avatarUrl && existing.avatar_url !== avatarUrl) {
                await supabase
                    .from("users")
                    .update({ avatar_url: avatarUrl })
                    .eq("idtg", userId);
            }
            return true;
        }

        const key = await generateUniqueKey();
        if (!key) {
            console.error(
                "generateUniqueKey: не удалось сгенерировать уникальный ключ",
            );
            return false;
        }

        const { error: insertError } = await supabase.from("users").insert({
            name: fullName,
            idtg: userId,
            user_name_tg: username,
            key: key,
            total_purchases: 0,
            role: "user",
            registration_date: new Date().toISOString().split("T")[0],
            avatar_url: avatarUrl,
        });

        if (insertError) {
            console.error("registerUser insert error:", insertError);
            return false;
        }

        console.log(`Новый пользователь: ${userId}, ключ: ${key}`);
        return true;
    } catch (e) {
        console.error("registerUser exception:", e);
        return false;
    }
};

bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    pendingSupportUsers.delete(ctx.from.id);
    await registerUser(ctx.telegram, ctx.from);
    await sendMainMenu(ctx);
});

bot.action("support_start", async (ctx) => {
    await ctx.answerCbQuery();
    pendingSupportUsers.add(ctx.from.id);

    await ctx.editMessageText(
        "Пожалуйста, опишите вашу ситуацию, и ожидайте.",
        {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("Отмена", "support_cancel")],
            ]),
        },
    );
});

bot.action("support_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    pendingSupportUsers.delete(userId);

    await ctx.deleteMessage().catch(() => {});

    const { data: ticket } = await supabase
        .from("tickets")
        .select("*")
        .eq("user_id", userId)
        .not("status", "eq", "closed")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (ticket) {
        const threadId = ticket.thread_id;

        const closeMsg = await ctx.telegram
            .sendMessage(GROUP_ID, "Пользователь закрыл тикет", {
                message_thread_id: threadId,
            })
            .catch(() => null);
        if (closeMsg) await trackBotMsg(threadId, closeMsg.message_id);

        await supabase
            .from("tickets")
            .update({
                status: "closed",
                updated_at: new Date().toISOString(),
            })
            .eq("thread_id", threadId);

        await cleanUpTicketData(ctx.telegram, ticket);

        if (ticket.notif_msg_id) {
            await ctx.telegram
                .deleteMessage(ADMIN_CHAT_ID, ticket.notif_msg_id)
                .catch(() => {});
        }

        await ctx.telegram.closeForumTopic(GROUP_ID, threadId).catch(() => {});
    }

    await sendMainMenu(ctx);
});

bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private" || ctx.message.text?.startsWith("/"))
        return next();

    const userId = ctx.from.id;
    const userName =
        `${ctx.from.first_name} ${ctx.from.last_name || ""}`.trim();

    try {
        const { data: ticket, error: fetchError } = await supabase
            .from("tickets")
            .select("*")
            .eq("user_id", userId)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (fetchError) {
            await ctx.reply("Произошла ошибка. Попробуйте позже.");
            return;
        }

        if (!ticket && !pendingSupportUsers.has(userId)) return;

        let threadId;

        if (!ticket) {
            pendingSupportUsers.delete(userId);
            threadId = await createNewTopic(ctx, userId, userName);
            if (!threadId) return;
        } else if (ticket.status === "closed") {
            if (!pendingSupportUsers.has(userId)) return;
            pendingSupportUsers.delete(userId);

            threadId = ticket.thread_id;
            await ctx.telegram
                .reopenForumTopic(GROUP_ID, threadId)
                .catch(() => {});

            const notifMsg = await ctx.telegram.sendMessage(
                ADMIN_CHAT_ID,
                `*Тикет*\nПользователь: ${userName} (\`${userId}\`)\nСтатус: *не взят*`,
                {
                    parse_mode: "Markdown",
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback(
                                "Взять тикет",
                                `take_${threadId}`,
                            ),
                        ],
                    ]),
                },
            );

            await supabase
                .from("tickets")
                .update({
                    status: "open",
                    assigned_to: null,
                    assigned_name: null,
                    last_reply_by: "user",
                    notif_msg_id: notifMsg.message_id,
                    bot_topic_msg_ids: "[]",
                    admin_pm_msg_id: null,
                    admin_pm_chat_id: null,
                    updated_at: new Date().toISOString(),
                })
                .eq("thread_id", threadId);
        } else {
            pendingSupportUsers.delete(userId);
            threadId = ticket.thread_id;
            await supabase
                .from("tickets")
                .update({
                    last_reply_by: "user",
                    updated_at: new Date().toISOString(),
                })
                .eq("thread_id", threadId);
        }

        await ctx.telegram.forwardMessage(
            GROUP_ID,
            ctx.chat.id,
            ctx.message.message_id,
            {
                message_thread_id: threadId,
            },
        );
    } catch {
        await ctx.reply("Произошла ошибка. Попробуйте позже.");
    }
});

bot.action(/^take_(\d+)$/, async (ctx) => {
    const threadId = parseInt(ctx.match[1]);
    const modId = ctx.from.id;

    try {
        const { data: ticket } = await supabase
            .from("tickets")
            .select("*")
            .eq("thread_id", threadId)
            .maybeSingle();

        if (!ticket)
            return ctx.answerCbQuery("Тикет не найден.", {
                show_alert: true,
            });
        if (ticket.status === "closed")
            return ctx.answerCbQuery("Тикет уже закрыт.", {
                show_alert: true,
            });
        if (ticket.status === "active")
            return ctx.answerCbQuery(
                `Тикет уже взят: ${ticket.assigned_name}`,
                { show_alert: true },
            );

        const modDisplay = await getModDisplay(ctx.telegram, modId, ctx.from);
        const topicLink = getTopicLink(GROUP_ID, threadId);

        const pmMsg = await ctx.telegram
            .sendMessage(modId, `📂 Открыть тикет: ${topicLink}`)
            .catch(() => null);

        await supabase
            .from("tickets")
            .update({
                status: "active",
                assigned_to: modId,
                assigned_name: modDisplay,
                admin_pm_msg_id: pmMsg?.message_id || null,
                admin_pm_chat_id: pmMsg ? modId : null,
                updated_at: new Date().toISOString(),
            })
            .eq("thread_id", threadId);

        await ctx
            .editMessageText(
                `*Тикет взят*\nПользователь: \`${ticket.user_id}\`\nВзял: *${modDisplay}*`,
                { parse_mode: "Markdown" },
            )
            .catch(() => {});

        const topicMsg = await ctx.telegram.sendMessage(
            GROUP_ID,
            `Тикет взял: *${modDisplay}*\n\nКоманды: /close /end /give @username`,
            { parse_mode: "Markdown", message_thread_id: threadId },
        );
        await trackBotMsg(threadId, topicMsg.message_id);

        await ctx.telegram
            .sendMessage(
                ticket.user_id,
                `Ваше обращение взято администратором *${modDisplay}*`,
                { parse_mode: "Markdown" },
            )
            .catch(() => {});

        await ctx.answerCbQuery("Ссылка отправлена в личку.");
    } catch {
        await ctx.answerCbQuery("Произошла ошибка.", { show_alert: true });
    }
});

bot.on("message", async (ctx, next) => {
    if (
        ctx.chat.id.toString() !== GROUP_ID.toString() ||
        !ctx.message.message_thread_id
    )
        return next();

    const threadId = ctx.message.message_thread_id;
    const modId = ctx.from.id;

    if (
        ctx.message.forum_topic_created ||
        ctx.message.forum_topic_edited ||
        ctx.message.forum_topic_closed ||
        ctx.message.forum_topic_reopened ||
        ctx.message.forward_origin ||
        ctx.message.forward_from ||
        ctx.message.text?.startsWith("/")
    )
        return next();

    try {
        const { data: ticket } = await supabase
            .from("tickets")
            .select("*")
            .eq("thread_id", threadId)
            .maybeSingle();
        if (!ticket) return;

        if (ticket.status === "closed") {
            const admin = await isGroupAdmin(ctx.telegram, modId);
            if (!admin) return;
            await ctx.telegram.copyMessage(
                ticket.user_id,
                ctx.chat.id,
                ctx.message.message_id,
            );
            return;
        }

        if (
            ticket.status === "active" &&
            ticket.assigned_to &&
            ticket.assigned_to !== modId
        ) {
            const warnMsg = await ctx.reply(
                `Тикет ведёт *${ticket.assigned_name}*. Только он может отвечать.\n\n/give @username — передать, /end — отпустить.`,
                { parse_mode: "Markdown", message_thread_id: threadId },
            );
            await trackBotMsg(threadId, warnMsg.message_id);
            return;
        }

        await ctx.telegram.copyMessage(
            ticket.user_id,
            ctx.chat.id,
            ctx.message.message_id,
        );
        await supabase
            .from("tickets")
            .update({
                last_reply_by: "agent",
                updated_at: new Date().toISOString(),
            })
            .eq("thread_id", threadId);
    } catch {
        await ctx.reply(
            "Не удалось доставить сообщение. Возможно, бот заблокирован.",
            {
                message_thread_id: threadId,
            },
        );
    }
});

bot.command("close", async (ctx) => {
    if (
        ctx.chat.id.toString() !== GROUP_ID.toString() ||
        !ctx.message.message_thread_id
    )
        return;

    const threadId = ctx.message.message_thread_id;
    const modId = ctx.from.id;

    try {
        const { data: ticket } = await supabase
            .from("tickets")
            .select("*")
            .eq("thread_id", threadId)
            .maybeSingle();

        if (!ticket || ticket.status === "closed") {
            const m = await ctx.reply("Тикет уже закрыт.", {
                message_thread_id: threadId,
            });
            await trackBotMsg(threadId, m.message_id);
            return;
        }

        if (
            ticket.status === "active" &&
            ticket.assigned_to &&
            ticket.assigned_to !== modId
        ) {
            const m = await ctx.reply(
                `Закрыть может только *${ticket.assigned_name}*.`,
                { parse_mode: "Markdown", message_thread_id: threadId },
            );
            await trackBotMsg(threadId, m.message_id);
            return;
        }

        await ctx.deleteMessage().catch(() => {});
        await ctx.telegram
            .sendMessage(
                ticket.user_id,
                "Ваше обращение закрыто. Если появятся новые вопросы - напишите нам снова.",
            )
            .catch(() => {});
        await supabase
            .from("tickets")
            .update({ status: "closed", updated_at: new Date().toISOString() })
            .eq("thread_id", threadId);

        await cleanUpTicketData(ctx.telegram, ticket);

        if (ticket.notif_msg_id) {
            await ctx.telegram
                .deleteMessage(ADMIN_CHAT_ID, ticket.notif_msg_id)
                .catch(() => {});
        }
        await ctx.telegram.closeForumTopic(GROUP_ID, threadId).catch(() => {});
    } catch {
        await ctx.reply("Ошибка при закрытии.", {
            message_thread_id: threadId,
        });
    }
});

bot.command("end", async (ctx) => {
    if (
        ctx.chat.id.toString() !== GROUP_ID.toString() ||
        !ctx.message.message_thread_id
    )
        return;

    const threadId = ctx.message.message_thread_id;
    const modId = ctx.from.id;

    try {
        const { data: ticket } = await supabase
            .from("tickets")
            .select("*")
            .eq("thread_id", threadId)
            .maybeSingle();

        if (!ticket || ticket.status === "closed") {
            const m = await ctx.reply("Тикет не найден или закрыт.", {
                message_thread_id: threadId,
            });
            await trackBotMsg(threadId, m.message_id);
            return;
        }

        if (
            ticket.status === "active" &&
            ticket.assigned_to &&
            ticket.assigned_to !== modId
        ) {
            const m = await ctx.reply(
                `Отпустить может только *${ticket.assigned_name}*.`,
                { parse_mode: "Markdown", message_thread_id: threadId },
            );
            await trackBotMsg(threadId, m.message_id);
            return;
        }

        await ctx.deleteMessage().catch(() => {});
        await cleanUpTicketData(ctx.telegram, ticket);

        await supabase
            .from("tickets")
            .update({
                status: "open",
                assigned_to: null,
                assigned_name: null,
                admin_pm_msg_id: null,
                admin_pm_chat_id: null,
                updated_at: new Date().toISOString(),
            })
            .eq("thread_id", threadId);

        if (ticket.notif_msg_id) {
            await ctx.telegram
                .editMessageText(
                    ADMIN_CHAT_ID,
                    ticket.notif_msg_id,
                    null,
                    `*Тикет освобождён!*\nПользователь: \`${ticket.user_id}\`\nСтатус: *ожидает администратора*`,
                    {
                        parse_mode: "Markdown",
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback(
                                    "Взять тикет",
                                    `take_${threadId}`,
                                ),
                            ],
                        ]),
                    },
                )
                .catch(() => {});
        }

        const m = await ctx.reply("Тикет освобождён.", {
            message_thread_id: threadId,
        });
        await trackBotMsg(threadId, m.message_id);
    } catch {
        await ctx.reply("Ошибка.", { message_thread_id: threadId });
    }
});

bot.command("give", async (ctx) => {
    if (
        ctx.chat.id.toString() !== GROUP_ID.toString() ||
        !ctx.message.message_thread_id
    )
        return;

    const threadId = ctx.message.message_thread_id;
    const modId = ctx.from.id;
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (!args[0]) {
        const m = await ctx.reply(
            "Использование:\n`/give @username` или `/give 123456789`",
            { parse_mode: "Markdown", message_thread_id: threadId },
        );
        await trackBotMsg(threadId, m.message_id);
        return;
    }

    try {
        const { data: ticket } = await supabase
            .from("tickets")
            .select("*")
            .eq("thread_id", threadId)
            .maybeSingle();

        if (!ticket || ticket.status === "closed") {
            const m = await ctx.reply("Тикет не найден или закрыт.", {
                message_thread_id: threadId,
            });
            await trackBotMsg(threadId, m.message_id);
            return;
        }

        if (
            ticket.status === "active" &&
            ticket.assigned_to &&
            ticket.assigned_to !== modId
        ) {
            const m = await ctx.reply(
                `Передать может только *${ticket.assigned_name}*.`,
                { parse_mode: "Markdown", message_thread_id: threadId },
            );
            await trackBotMsg(threadId, m.message_id);
            return;
        }

        const newModId = resolveTarget(ctx, args);
        if (!newModId) {
            const m = await ctx.reply(
                "Укажите числовой ID или ответьте на сообщение пользователя.",
                { message_thread_id: threadId },
            );
            await trackBotMsg(threadId, m.message_id);
            return;
        }

        await ctx.deleteMessage().catch(() => {});
        await cleanUpTicketData(ctx.telegram, ticket);

        const newModDisplay = await getModDisplay(ctx.telegram, newModId, null);
        const topicLink = getTopicLink(GROUP_ID, threadId);
        const pmMsg = await ctx.telegram
            .sendMessage(
                newModId,
                `Вам передан тикет!\nОткрыть тему: ${topicLink}\n\nКоманды: /close /end /give @username`,
            )
            .catch(() => null);

        await supabase
            .from("tickets")
            .update({
                status: "active",
                assigned_to: newModId,
                assigned_name: newModDisplay,
                admin_pm_msg_id: pmMsg?.message_id || null,
                admin_pm_chat_id: pmMsg ? newModId : null,
                updated_at: new Date().toISOString(),
            })
            .eq("thread_id", threadId);

        const topicMsg = await ctx.telegram.sendMessage(
            GROUP_ID,
            `🔄 Тикет передан: *${newModDisplay}*`,
            { parse_mode: "Markdown", message_thread_id: threadId },
        );
        await trackBotMsg(threadId, topicMsg.message_id);
    } catch {
        await ctx.reply("Ошибка при передаче.", {
            message_thread_id: threadId,
        });
    }
});

bot.command("pending", async (ctx) => {
    if (ctx.chat.type === "private") return;

    try {
        const { data: tickets, error } = await supabase
            .from("tickets")
            .select("*")
            .in("status", ["open", "active"])
            .eq("last_reply_by", "user")
            .order("updated_at", { ascending: true });

        if (error || !tickets || tickets.length === 0) {
            return ctx.reply("Нет неотвеченных обращений.", {
                message_thread_id: ctx.message.message_thread_id,
            });
        }

        let messageText = `*Неотвеченные (${tickets.length}):*\n\n`;
        const buttons = [];

        tickets.forEach((ticket, index) => {
            const link = getTopicLink(GROUP_ID, ticket.thread_id);
            const assignedInfo = ticket.assigned_to
                ? `🛡 ${ticket.assigned_name}`
                : "Свободен";
            messageText += `${index + 1}. \`${ticket.user_id}\` — ${assignedInfo}\n`;
            buttons.push([
                Markup.button.url(`Тикет #${ticket.thread_id}`, link),
            ]);
        });

        await ctx.reply(messageText, {
            parse_mode: "Markdown",
            message_thread_id: ctx.message.message_thread_id,
            ...Markup.inlineKeyboard(buttons),
        });
    } catch {
        await ctx.reply("Ошибка.", {
            message_thread_id: ctx.message.message_thread_id,
        });
    }
});

bot.command("arole", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 4);

    if (access === "silent") return;
    if (access === "denied") {
        const m = await ctx.reply(
            `Требуется уровень: *4*. Ваш уровень: *${senderRole}*`,
            { parse_mode: "Markdown", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const reply = ctx.message.reply_to_message;

    let targetId = null;
    let roleNum = null;
    let newName = null;

    if (reply) {
        if (!reply.from || reply.from.is_bot) return;
        targetId = reply.from.id;
        roleNum = parseInt(args[0]);
        if (args.length > 1) newName = args.slice(1).join(" ");
    } else {
        if (args.length < 2) {
            const m = await ctx.reply(
                "Использование:\n`/arole 123456789 2 Ник`\nИли ответьте на сообщение: `/arole 2 Ник`",
                { parse_mode: "Markdown", message_thread_id: threadId },
            );
            if (threadId) await trackBotMsg(threadId, m.message_id);
            return;
        }

        targetId = parseInt(args[0]);
        roleNum = parseInt(args[1]);
        if (args.length > 2) newName = args.slice(2).join(" ");
    }

    if (isNaN(targetId) || isNaN(roleNum) || roleNum < 0 || roleNum > 6) {
        const m = await ctx.reply("Ошибка в параметрах.", {
            message_thread_id: threadId,
        });
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    if (roleNum > senderRole) {
        const m = await ctx.reply(
            `Нельзя выдать роль *${roleNum}* — она выше вашей (*${senderRole}*).`,
            { parse_mode: "Markdown", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const targetMod = await getMod(targetId);
    if (targetMod && targetMod.role >= senderRole && targetId !== senderId) {
        const m = await ctx.reply(
            "Нельзя изменить роль пользователю с уровнем, равным или выше вашего.",
            { message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    await ctx.deleteMessage().catch(() => {});
    const giverName = await getModDisplay(ctx.telegram, senderId, ctx.from);

    if (roleNum === 0) {
        await supabase.from("moderator_tg").delete().eq("idtg", targetId);
        const m = await ctx.reply(`Роль снята с \`${targetId}\`.`, {
            parse_mode: "Markdown",
            message_thread_id: threadId,
        });
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const updateData = {
        idtg: targetId,
        role: roleNum,
        give: giverName,
        updated_at: new Date().toISOString(),
    };
    if (newName) updateData.name = newName;

    await supabase
        .from("moderator_tg")
        .upsert(updateData, { onConflict: "idtg" });

    const m = await ctx.reply(
        `\`${targetId}\` — роль *${roleNum}* выдана.${newName ? `\n🏷 Ник: *${newName}*` : ""}\n👤 Выдал: ${giverName}`,
        { parse_mode: "Markdown", message_thread_id: threadId },
    );
    if (threadId) await trackBotMsg(threadId, m.message_id);
});

bot.command("setnick", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 3);

    if (access === "silent") return;
    if (access === "denied") {
        const m = await ctx.reply(
            `<blockquote><b>Ошибка доступа</b>\nТребуется уровень: <b>3</b>\nВаш уровень: <b>${senderRole}</b></blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const reply = ctx.message.reply_to_message;

    let targetId = null;
    let newName = null;

    if (reply) {
        targetId = reply.from?.id;
        newName = args.join(" ");
    } else {
        if (args.length < 2) {
            const m = await ctx.reply(
                `<blockquote><b>Использование:</b>\n<code>/setnick 123456789 Ник</code>\n\n<i>Также можно ответить на сообщение пользователя: <code>/setnick Ник</code></i></blockquote>`,
                { parse_mode: "HTML", message_thread_id: threadId },
            );
            if (threadId) await trackBotMsg(threadId, m.message_id);
            return;
        }

        targetId = parseInt(args[0]);
        newName = args.slice(1).join(" ");
    }

    if (!newName?.trim() || isNaN(targetId)) return;

    const targetMod = await getMod(targetId);
    if (!targetMod) {
        const m = await ctx.reply(
            `<blockquote>Пользователь <code>${targetId}</code> не найден в базе данных.</blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    if (targetMod.role >= senderRole) {
        const m = await ctx.reply(
            `<blockquote><b>Действие запрещено</b>\nУровень пользователя (<b>${targetMod.role}</b>) не ниже вашего (<b>${senderRole}</b>).</blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    await ctx.deleteMessage().catch(() => {});
    await supabase
        .from("moderator_tg")
        .update({ name: newName.trim() })
        .eq("idtg", targetId);

    const m = await ctx.reply(
        `<blockquote><b>Ник успешно установлен</b>\nID: <code>${targetId}</code>\nНовый ник: <b>${newName.trim()}</b></blockquote>`,
        { parse_mode: "HTML", message_thread_id: threadId },
    );
    if (threadId) await trackBotMsg(threadId, m.message_id);
});

bot.command("staff", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 4);

    if (access === "silent") return;
    if (access === "denied") return;

    const chatId = ctx.chat.id;
    const { data: allMods } = await supabase
        .from("moderator_tg")
        .select("*")
        .order("role", { ascending: false });

    if (!allMods || allMods.length === 0) return;

    const inChat = [];
    for (const mod of allMods) {
        try {
            const member = await ctx.telegram.getChatMember(chatId, mod.idtg);
            if (!["left", "kicked", "restricted"].includes(member.status)) {
                inChat.push(mod);
            }
        } catch {}
    }

    if (inChat.length === 0) return;

    let text = `<b>Состав группы [${inChat.length}]</b>:\n\n`;

    for (const mod of inChat) {
        const nick = mod.name
            ? `<b>${mod.name}</b>`
            : `<code>${mod.idtg}</code>`;
        text += `<blockquote>🔹 ${nick} — Уровень <b>${mod.role}</b></blockquote>\n`;
    }

    const m = await ctx.reply(text, {
        parse_mode: "HTML",
        message_thread_id: threadId,
    });
    if (threadId) await trackBotMsg(threadId, m.message_id);
});

bot.command("astaff", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 5);

    if (access === "silent") return;
    if (access === "denied") return;

    const { data: allMods } = await supabase
        .from("moderator_tg")
        .select("*")
        .order("role", { ascending: false });

    if (!allMods || allMods.length === 0) return;

    let text = `<b>Общий состав</b> [${allMods.length}]:\n\n`;

    for (const mod of allMods) {
        const nick = mod.name
            ? `<b>${mod.name}</b>`
            : `<code>${mod.idtg}</code>`;
        const giver = mod.give ? `\n └ Выдал: ${mod.give}` : "";
        text += `<blockquote>🔹 ${nick} — Уровень <b>${mod.role}</b>${giver}</blockquote>\n`;
    }

    const m = await ctx.reply(text, {
        parse_mode: "HTML",
        message_thread_id: threadId,
    });
    if (threadId) await trackBotMsg(threadId, m.message_id);
});

const resolveKickTarget = async (ctx, args, threadId) => {
    const reply = ctx.message?.reply_to_message;
    if (reply) {
        if (!reply.from || reply.from.is_bot) {
            const m = await ctx.reply("Нельзя применить к боту.", {
                message_thread_id: threadId,
            });
            if (threadId) await trackBotMsg(threadId, m.message_id);
            return null;
        }
        return reply.from.id;
    }
    if (args[0]) {
        const id = parseInt(args[0]);
        if (!isNaN(id)) return id;
    }
    const m = await ctx.reply(
        "Укажите ID пользователя или ответьте на его сообщение.\nПример: <code>/kick 123456789</code>",
        { parse_mode: "HTML", message_thread_id: threadId },
    );
    if (threadId) await trackBotMsg(threadId, m.message_id);
    return null;
};

bot.command("kick", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 4);

    if (access === "silent") return;
    if (access === "denied") {
        const m = await ctx.reply(
            `<blockquote><b>Ошибка доступа</b>\nТребуется уровень: <b>4</b>\nВаш уровень: <b>${senderRole}</b></blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetId = await resolveKickTarget(ctx, args, threadId);
    if (!targetId) return;

    const chatId = ctx.chat.id;
    await ctx.deleteMessage().catch(() => {});

    try {
        await ctx.telegram.banChatMember(chatId, targetId, {
            until_date: Math.floor(Date.now() / 1000) + 35,
        });
        await ctx.telegram.unbanChatMember(chatId, targetId);
        const senderName = await getModDisplay(
            ctx.telegram,
            senderId,
            ctx.from,
        );
        const m = await ctx.reply(
            `<blockquote><b>Кик</b>\nID: <code>${targetId}</code>\nВыполнил: <b>${senderName}</b></blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
    } catch (e) {
        const m = await ctx.reply(
            `<blockquote>Не удалось кикнуть <code>${targetId}</code>.\nВозможно, пользователь — администратор.</blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
    }
});

bot.command("lkick", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 4);

    if (access === "silent") return;
    if (access === "denied") {
        const m = await ctx.reply(
            `<blockquote><b>Ошибка доступа</b>\nТребуется уровень: <b>4</b>\nВаш уровень: <b>${senderRole}</b></blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetId = await resolveKickTarget(ctx, args, threadId);
    if (!targetId) return;

    await ctx.deleteMessage().catch(() => {});

    const results = [];
    for (const group of LOCAL_GROUPS) {
        try {
            await ctx.telegram.banChatMember(group.id, targetId, {
                until_date: Math.floor(Date.now() / 1000) + 35,
            });
            await ctx.telegram.unbanChatMember(group.id, targetId);
            results.push(`${group.name}`);
        } catch {
            results.push(`${group.name}`);
        }
    }

    const senderName = await getModDisplay(ctx.telegram, senderId, ctx.from);
    const m = await ctx.reply(
        `<blockquote><b>Локальный кик</b>\nID: <code>${targetId}</code>\nВыполнил: <b>${senderName}</b>\n\n${results.join("\n")}</blockquote>`,
        { parse_mode: "HTML", message_thread_id: threadId },
    );
    if (threadId) await trackBotMsg(threadId, m.message_id);
});

bot.command("ban", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 4);

    if (access === "silent") return;
    if (access === "denied") {
        const m = await ctx.reply(
            `<blockquote><b>Ошибка доступа</b>\nТребуется уровень: <b>4</b>\nВаш уровень: <b>${senderRole}</b></blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetId = await resolveKickTarget(ctx, args, threadId);
    if (!targetId) return;

    const chatId = ctx.chat.id;
    await ctx.deleteMessage().catch(() => {});

    try {
        await ctx.telegram.banChatMember(chatId, targetId);
        const senderName = await getModDisplay(
            ctx.telegram,
            senderId,
            ctx.from,
        );
        const m = await ctx.reply(
            `<blockquote><b>Бан</b>\nID: <code>${targetId}</code>\nВыполнил: <b>${senderName}</b></blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
    } catch {
        const m = await ctx.reply(
            `<blockquote>Не удалось забанить <code>${targetId}</code>.\nВозможно, пользователь — администратор.</blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
    }
});

bot.command("lban", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const access = checkAccess(senderRole, 5);

    if (access === "silent") return;
    if (access === "denied") {
        const m = await ctx.reply(
            `<blockquote><b>Ошибка доступа</b>\nТребуется уровень: <b>5</b>\nВаш уровень: <b>${senderRole}</b></blockquote>`,
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetId = await resolveKickTarget(ctx, args, threadId);
    if (!targetId) return;

    await ctx.deleteMessage().catch(() => {});

    const results = [];
    for (const group of ALL_GROUPS) {
        try {
            await ctx.telegram.banChatMember(group.id, targetId);
            results.push(`${group.name}`);
        } catch {
            results.push(`${group.name}`);
        }
    }

    const senderName = await getModDisplay(ctx.telegram, senderId, ctx.from);
    const m = await ctx.reply(
        `<blockquote>🔨 <b>Глобальный бан</b>\nID: <code>${targetId}</code>\nВыполнил: <b>${senderName}</b>\n\n${results.join("\n")}</blockquote>`,
        { parse_mode: "HTML", message_thread_id: threadId },
    );
    if (threadId) await trackBotMsg(threadId, m.message_id);
});

bot.command("m", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const senderId = ctx.from.id;
    const senderRole = await getSenderRole(ctx.telegram, senderId);
    const threadId = ctx.message.message_thread_id;
    const chatId = ctx.chat.id.toString();

    if (senderRole === 0) return;

    const text = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (!text) {
        const m = await ctx.reply(
            "<blockquote>Укажите текст сообщения.\nПример: <code>/m Привет всем!</code></blockquote>",
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const sourceName = getGroupName(chatId);

    let targets = [];

    if (senderRole >= 2) {
        targets = LOCAL_GROUPS.filter((g) => g.id !== chatId);
    } else if (senderRole === 1) {
        if (chatId === GROUP_S_TEAM && GROUP_T_TEAM) {
            targets = [{ id: GROUP_T_TEAM, name: GROUP_T_TEAM_NAME }];
        } else if (chatId === GROUP_T_TEAM && GROUP_S_TEAM) {
            targets = [{ id: GROUP_S_TEAM, name: GROUP_S_TEAM_NAME }];
        } else {
            const m = await ctx.reply(
                "<blockquote>Недостаточно прав для отправки из этой группы.</blockquote>",
                { parse_mode: "HTML", message_thread_id: threadId },
            );
            if (threadId) await trackBotMsg(threadId, m.message_id);
            return;
        }
    }

    if (targets.length === 0) {
        const m = await ctx.reply(
            "<blockquote>Нет доступных групп для отправки.</blockquote>",
            { parse_mode: "HTML", message_thread_id: threadId },
        );
        if (threadId) await trackBotMsg(threadId, m.message_id);
        return;
    }

    const senderName = await getModDisplay(ctx.telegram, senderId, ctx.from);
    await ctx.deleteMessage().catch(() => {});

    const sent = [];
    const failed = [];

    for (const target of targets) {
        try {
            await ctx.telegram.sendMessage(
                target.id,
                `<blockquote>Сообщение из <b>${sourceName}</b>\nОт: <b>${senderName}</b></blockquote>\n- ${text}`,
                { parse_mode: "HTML" },
            );
            sent.push(target.name);
        } catch {
            failed.push(target.name);
        }
    }

    const lines = [];
    if (sent.length > 0)
        lines.push(
            `Отправлено в: ${sent.map((n) => `<b>${n}</b>`).join(", ")}`,
        );
    if (failed.length > 0)
        lines.push(
            `Ошибка в: ${failed.map((n) => `<b>${n}</b>`).join(", ")}`,
        );

    const confirm = await ctx.reply(
        `<blockquote>${lines.join("\n")}\n\n- ${text}</blockquote>`,
        { parse_mode: "HTML", message_thread_id: threadId },
    );
    if (threadId) await trackBotMsg(threadId, confirm.message_id);
});

bot.launch().then(() => {
    console.log("Бот запущен!");
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
}).listen(PORT, "0.0.0.0", () => {
    console.log(`Health server on port ${PORT}`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
