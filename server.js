const ssh2 = require("ssh2");
const net = require("net");
const NodePTY = require("node-pty-prebuilt-multiarch");
const child_process = require("child_process");

function createServer(opts) {
  const { hostKeys, authorizedKeys, shell, logger } = opts;

  return new ssh2.Server({ hostKeys }, (client) => {
    logger.log("Client connected!");

    client.on("authentication", (ctx) => {
      logger.log("auth:", ctx.method, ctx?.key?.algo);
      if (
        ctx.method === "publickey" &&
        ctx.key.algo == "ssh-ed25519" &&
        authorizedKeys.includes(ctx.key.data.toString("base64"))
      ) {
        ctx.accept();
      } else {
        ctx.reject(["publickey"]);
      }
    });

    client.on("ready", () => {
      client.on("session", (accept, _reject) => {
        const session = accept();

        session.on("exec", (accept, _reject, payload) => {
          const command = payload.command;
          const channel = accept();
          logger.log("exec:", payload);
          const child = child_process.spawn(command, {
            shell: shell,
            cwd: process.env.HOME,
          });
          channel.stdin.pipe(child.stdin);
          child.stdout.pipe(channel.stdout);
          child.stderr.pipe(channel.stderr);
          child.on("exit", (code) => {
            logger.log("exec child exit:", code);
            channel.exit(0);
            channel.end();
          });
        });

        session.on("pty", (accept, _reject, info) => {
          logger.log("PTY", info);
          session.ptyInfo = info;
          accept();
        });

        session.on("shell", (accept, _reject) => {
          const shellStream = accept();
          const pty = NodePTY.spawn(shell, [], {
            name: session?.ptyInfo?.term || "xterm-color",
            cols: session?.ptyInfo?.cols || 80,
            rows: session?.ptyInfo?.rows || 24,
            cwd: process.env.HOME,
            //env: process.env,
            useConptyDll: true,
          });

          session.on("window-change", (accept, _reject, info) => {
            //console.log("window-change", info);
            accept && accept();
            pty.resize(info.cols, info.rows);
          });

          pty.onData((data) => shellStream.write(data));

          pty.onExit((_e, _signal) => shellStream.close());

          shellStream.on("data", (data) => pty.write(data));

          shellStream.on("close", () => {
            pty.kill();
          });
        });

        session.on("env", (accept, reject, info) => {
          logger.log("env", accept, reject, info);
        });

        session.on("subsystem", (accept, reject, info) => {
          logger.log("subsystem", accept, reject, info);
          reject();
        });

        session.on("auth-agent", (accept, reject) => {
          logger.log("auth-agent", accept, reject);
          reject();
        });
      });
    });

    client.on("error", (context) => {
      logger.log("client.error:", context);
    });

    client.on("request", (accept, reject, name, info) => {
      logger.log("request", accept, reject, name, info);
      if (name === "tcpip-forward") {
        const chosenPort = info.bindPort || 6666;
        let forwarderSrv = new net.Server(function (socket) {
          logger.log("forwardOut", info.bindAddr, chosenPort);
          client.forwardOut(
            info.bindAddr,
            chosenPort,
            socket.remoteAddress,
            socket.remotePort,
            (err, upstream) => {
              if (err) {
                socket.end();
                return logger.error("Forwarding failed: " + err);
              }
              upstream.pipe(socket);
              socket.pipe(upstream);
            },
          );
        });

        forwarderSrv.listen({
          port: chosenPort,
          host: info.bindAddr,
        });

        forwarderSrv.on("listening", function () {
          accept(chosenPort);
          client.on("close", () => {
            //console.log("Closing remote:", info.bindAddr, chosenPort);
            forwarderSrv.close();
          });
        });

        forwarderSrv.on("error", function (e) {
          logger.log("not listening", e);
          reject();
        });
      } else if (name === "cancel-tcpip-forward") {
        logger.log("cancel-tcpip-forward");
        accept();
      } else {
        reject();
      }
    });

    client.on("tcpip", (accept, reject, info) => {
      logger.log("TCPIP", accept, reject, info);
      //return reject(); //TODO - pipe
      var stream = accept();
      var tcp = new net.Socket();

      tcp.pipe(stream);
      pipe.pipe(tcp);

      tcp.connect({
        host: info.destIP, //127.0.0.1
        port: info.destPort, //3221
      });
      //console.log("serverChannel", stream);
    });

    client.on("openssh.streamlocal", (accept, reject, info) => {
      logger.log("openssh.streamlocal", accept, reject, info);
      reject();
    });

    client.on("end", () => {
      logger.log("client disconnected");
    });
  });
}

module.exports = createServer;
