// easyauth.js — auto-register and auto-login for EasyAuth servers

function installEasyAuth(bot) {
  const password = process.env.NILO_PASSWORD ?? 'nilo123';

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().toLowerCase();
    if (text.includes('register') && text.includes('/register')) {
      bot.chat(`/register ${password} ${password}`);
    } else if (text.includes('login') && text.includes('/login')) {
      bot.chat(`/login ${password}`);
    }
  });
}

module.exports = { installEasyAuth };
