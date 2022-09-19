import { Telegraf, Markup } from 'telegraf';
import { encode, decode } from "messagepack";
import { readFileSync, writeFileSync } from 'fs';
import fast from 'fastify';
import fetch from 'node-fetch';
import md5 from 'md5';
import { v4 } from 'uuid';
import websocketPlugin from 'fastify-websocket';
import fastifyCors from 'fastify-cors';
import { generateToken } from 'node-2fa';


var settings =  JSON.parse(readFileSync("settings.json"))


function getIPLocation(ip) {
    return new Promise((resolve, reject)=>{
        fetch(settings.apiGeo+ip).then(res=>{
            if(res.status==200){
                res.json().then(j=>{
                    resolve(`${j?.city}, ${j?.country_name}`)
                }).catch(e=>{
                    console.log(e)
                    resolve(null)
                })
            }else{
                console.log(res)
                resolve(null)
            }
        }).catch((err)=>{
            console.log(err)
            resolve(null)
        })
    })
}


// Fastify register
const fastify = fast()
fastify.register(websocketPlugin)
fastify.register(fastifyCors, { 
    methods:["POST", "GET"],
    origin:"*" 
})

// Settings
var max = {
    appname:50,
    key:128,
    apps:10
}

// Database
var db = decode(readFileSync("db"))
setInterval(()=>{
    writeFileSync("db", encode(db))
}, 5000)


//Telegram bot
const bot = new Telegraf(settings.tgToken)

bot.start(async (ctx) => {
    if(ctx.update.message.chat.type=="private"){
        ctx.replyWithHTML(`Alright! Now follow the instructions!\n1. Set code to your service via command: /reg app-name 2FACODE\n2. Set your "ID" and "APP-NAME" in service! Your ID: <code>${ctx.update.message.from.id}</code>`)
    }else{
        ctx.reply("Use private chat!")
    }
})

bot.command("reg", async (ctx)=>{
    if(ctx.update.message.chat.type=="private"){
        if(db[ctx.update.message.from.id]==undefined) db[ctx.update.message.from.id]={}
        if(Object.keys(db[ctx.update.message.from.id]).length<=max.apps){
            var cmd = ctx.update.message.text.trim().replace(/[^0-9a-zA-Z\s\-\_]/gm, "").split(" ");
            if(cmd.length==3){
                if(cmd[1].length<=max.appname){
                    if(cmd[2].length<=max.key){
                        if(db[ctx.update.message.from.id][cmd[1]]==undefined){
                            ctx.reply(`Service "${cmd[1]}" registered!`)
                        }else{
                            ctx.reply(`Service "${cmd[1]}" re-registered!`)
                        }
                        db[ctx.update.message.from.id][cmd[1]]=cmd[2];
                    }else{
                        ctx.reply("key too long!");
                    }
                }else{
                    ctx.reply("app-name too long!");
                }
            }else{
                ctx.reply(`Use: /reg app-name 2FACODE\napp-name allows only: a-z,A-Z,-\n\nMax lengths:\napp-name: ${max.appname}\n2FACODE: ${max.key}`)
            }
        }else{
            ctx.reply(`Apps too many! Max: ${max.apps}`);
        }
    }else{
        ctx.reply("Use private chat!")
    }
})

bot.command("list", async (ctx)=>{
    if(ctx.update.message.chat.type=="private"){
        if(db[ctx.update.message.from.id]==undefined) db[ctx.update.message.from.id]={}
        if(Object.keys(db[ctx.update.message.from.id]).length==0){
            ctx.reply("You don't have services!")
        }else{
            ctx.replyWithHTML(`Services:\n${Object.keys(db[ctx.update.message.from.id]).map(key=>`${key} - <tg-spoiler>${db[ctx.update.message.from.id][key]}</tg-spoiler>`).join("\n")}`)
        }
    }else{
        ctx.reply("Use private chat!")
    }
})

bot.command("unreg", async (ctx)=>{
    if(ctx.update.message.chat.type=="private"){
        if(db[ctx.update.message.from.id]==undefined) db[ctx.update.message.from.id]={}
        var cmd = ctx.update.message.text.trim().replace(/[^0-9a-zA-Z\s\-\_]/gm, "").split(" ");
        if(cmd.length==2){
            if(cmd[1].length<=max.appname){
                if(db[ctx.update.message.from.id][cmd[1]]!=undefined){
                    delete db[ctx.update.message.from.id][cmd[1]];
                    ctx.reply(`Service "${cmd[1]}" unregistered!`)
                }else{
                    ctx.reply("Service not found!");
                }
            }else{
                ctx.reply("app-name too long!");
            }
        }else{
            ctx.reply(`Use: /unreg app-name`)
        }
    }else{
        ctx.reply("Use private chat!")
    }
})

bot.action("success", (ctx)=>{
    var n = ctx.update.callback_query.message.text.match(/\"[0-9a-zA-Z\-]*\"/gm);
    var m = ctx.update.callback_query.message.text.match(/Token\:\s[0-9a-z]{32}/gm);
    if(m&&n){
        var appname = n[0].slice(1, n[0].length-1);
        var token = m[0].slice(7);
        if(stack[token]){
            stack[token].act=true;
            clearTimeout(stack[token].timer)
            if(blocklist.indexOf(ctx.update.callback_query.message.chat.id+appname)==-1){
                if(db[ctx.update.callback_query.message.chat.id]&&db[ctx.update.callback_query.message.chat.id][appname]){
                    try {
                        stack[token].socket.send("o:"+generateToken(db[ctx.update.callback_query.message.chat.id][appname]).token)
                        ctx.editMessageText(ctx.update.callback_query.message.text.replace("Authorization will be automatically denied after 1 min.", `✅ Authed!`))
                        stack[token].socket.close()
                    }catch(e){
                        stack[token].socket.close(3006, "Bad 2fa code.")
                        ctx.editMessageText("Bad 2fa code.")
                    }
                }else{
                    stack[token].socket.close(3005, "Service not found.")
                    ctx.editMessageText("Service not found.")
                }
            }else{
                stack[token].socket.close(3004, "The service is in the block list.")
                ctx.editMessageText("The service is in the block list.")
            }
        }else{
            ctx.editMessageText("Session id closed.")
        }
    }else{
        ctx.editMessageText("Bot was unable to process the request.")
    }
})

bot.action("block", (ctx)=>{
    var n = ctx.update.callback_query.message.text.match(/\"[0-9a-zA-Z\-]*\"/gm);
    var m = ctx.update.callback_query.message.text.match(/Token\:\s[0-9a-z]{32}/gm);
    if(m&&n){
        var appname = n[0].slice(1, n[0].length-1);
        var token = m[0].slice(7);
        if(stack[token]){
            stack[token].act=true;
            clearTimeout(stack[token].timer)
            if(blocklist.indexOf(ctx.update.callback_query.message.chat.id+appname)==-1){
                blocklist.push(ctx.update.callback_query.message.chat.id+appname);
                setTimeout(()=>{
                    var index = blocklist.indexOf(ctx.update.callback_query.message.chat.id+appname);
                    if (index !== -1) {
                        blocklist.splice(index, 1);
                    }
                }, 3*60*60*1000) // 3 h
                stack[token].socket.close(3002, "Blocked.")
                ctx.editMessageText(ctx.update.callback_query.message.text.replace("Authorization will be automatically denied after 1 min.", `🔒 Service blocked!`))
            }else{
                stack[token].socket.close(3003, "The service is in the block list.")
                ctx.editMessageText("The service is in the block list.")
            }
        }else{
            ctx.editMessageText("Session id closed.")
        }
    }else{
        ctx.editMessageText("Bot was unable to process the request.")
    }
})


bot.launch()


var stack = {}
var blocklist = []


// Fastify pages
fastify.get('/:auther_id/:auther_appname', { websocket: true }, async (connection, req)=>{
    var {auther_id, auther_appname} = req.params;
    if(+auther_id!=NaN&&db[+auther_id]&&db[+auther_id][auther_appname]){
        if(blocklist.indexOf(auther_id+auther_appname)==-1) {
            var ip = req.headers["cf-connecting-ip"]
            var geo = await getIPLocation(ip);
            var token = md5(auther_id+auther_appname+ip+v4())
            connection.socket.send("t:"+token)
            bot.telegram.sendMessage(+auther_id, `Attempt to enter the service "${auther_appname}", with IP ${ip}.${(geo)?"\nLocation: "+geo:""}\nToken: ${token}\n\nAuthorization will be automatically denied after 1 min.`, Markup.inlineKeyboard([
                Markup.button.callback(`It's me`,'success'),
                Markup.button.callback(`Block (3h)`,'block')
            ])).then(ctx=>{
                stack[token]={
                    socket:connection.socket,
                    timer:setTimeout(()=>{
                        stack[token].act=true;
                        connection.socket.close(3001, "Timeout.")
                        bot.telegram.editMessageText(ctx.chat.id, ctx.message_id, "", ctx.text.replace("Authorization will be automatically denied after 1 min.", `❌ Auth denied!`)).catch(e=>{})
                    }, 60*1000), // 1 min
                    act:false,
                    mod:false
                };

                connection.socket.on("close", ()=>{
                    clearTimeout(stack[token].timer);
                    if(stack[token].act==false && stack[token].mod==false){
                        stack[token].mod=true
                        bot.telegram.editMessageText(ctx.chat.id, ctx.message_id, "", ctx.text.replace("Authorization will be automatically denied after 1 min.", `❌ Auth denied!`))
                    }
                });
            })
            

            // Close codes
            // 0 - Bad account data.
            // 1 - Timeout.
            // 2 - Blocked.
            // 3 - block - The service is in the block list.
            // 4 - success - The service is in the block list.
            // 5 - success - Service not found.
            // 6 - success - Bad 2fa code.
        }else{
            connection.socket.close(3002, "Blocked.")
        }
    }else{
        connection.socket.close(3000, "Bad account data.")
    }
})

fastify.listen(10000, '0.0.0.0')
