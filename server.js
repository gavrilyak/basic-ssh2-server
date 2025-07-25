const ssh2 = require("ssh2");
const NodePTY = require("node-pty-prebuilt-multiarch");
const net = require("net");
const child_process = require("child_process");
const os = require("os");
const process = require("process");

const SIGNALS = Object.fromEntries(
  Object.entries(os.constants.signals).map(([k, v]) => [v, k]),
);

function createServer(opts) {
  const { hostKeys, debug, authorizedKeys, shell, logger: console } = opts;

  return new ssh2.Server({ hostKeys, debug }, (client) => {
    console.log("Client connected!");
    client.on("handshake", () => console.log("handshake"));
    client.on("authentication", (ctx) => {
      console.log("auth:", ctx.method, ctx?.key?.algo);
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
        session.once("exec", (accept, _reject, payload) => {
          const command = payload.command;
          const stream = accept();
          console.log("exec:", payload);
          const child = child_process.spawn(command, {
            shell: shell,
            cwd: process.env.HOME,
          });
          child.on("exit", (exitCode, signal) => {
            console.log("exec child exit:", exitCode, signal);
            stream.exit(signal || exitCode);
          });
          child.on("close", () => stream.end());

          stream.stdin.pipe(child.stdin);
          child.stderr.pipe(stream.stderr);
          child.stdout.pipe(stream.stdout, { end: false });
        });

        session.on("pty", (accept, _reject, info) => {
          console.log("pty", info);
          session.ptyInfo = info;
          accept();
        });

        session.on("shell", (accept, _reject) => {
          const stream = accept();
          const pty = NodePTY.spawn(shell, [], {
            name: session?.ptyInfo?.term || "xterm-color",
            cols: session?.ptyInfo?.cols || 80,
            rows: session?.ptyInfo?.rows || 24,
            cwd: process.env.HOME,
            //env: process.env,
            useConptyDll: true,
          });

          session.on("window-change", (accept, _reject, info) => {
            console.log("window-change", info);
            accept && accept();
            pty.resize(info.cols, info.rows);
          });

          pty.onData((data) => stream.write(data));
          pty.onExit(({ exitCode, signal }) => {
            const signalName = SIGNALS[signal];
            console.log("pty exit", exitCode, signalName);
            stream.exit(signalName || exitCode);
            stream.close();
          });
          stream.on("data", (data) => pty.write(data));
          stream.on("close", () => pty.kill());
        });

        session.on("env", (accept, reject, info) => {
          console.log("env", accept, reject, info);
          accept();
        });

        session.on("subsystem", (accept, reject, info) => {
          console.log("subsystem", accept, reject, info);
          reject();
        });

        session.on("auth-agent", (accept, reject) => {
          console.log("auth-agent", accept, reject);
          reject();
        });
      });
    });

    client.on("error", (context) => {
      console.log("client.error:", context);
    });

    client.on("request", (accept, reject, name, info) => {
      console.log("request", accept, reject, name, info);
      if (name === "tcpip-forward") {
        const chosenPort = info.bindPort || 6666;
        let forwarderSrv = new net.Server(function (socket) {
          console.log("forwardOut", info.bindAddr, chosenPort);
          client.forwardOut(
            info.bindAddr,
            chosenPort,
            socket.remoteAddress,
            socket.remotePort,
            (err, upstream) => {
              if (err) {
                socket.end();
                return console.error("Forwarding failed: " + err);
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
          console.log("not listening", e);
          reject();
        });
      } else if (name === "cancel-tcpip-forward") {
        console.log("cancel-tcpip-forward");
        accept();
      } else {
        reject();
      }
    });

    client.on("tcpip", (accept, reject, info) => {
      console.log("TCPIP", accept, reject, info);
      //return reject(); //TODO - pipe
      var stream = accept();
      var tcp = new net.Socket();

      tcp.pipe(stream);
      stream.pipe(tcp);

      tcp.connect({
        host: info.destIP, //127.0.0.1
        port: info.destPort, //3221
      });
      //console.log("serverChannel", stream);
    });

    client.on("openssh.streamlocal", (accept, reject, info) => {
      console.log("openssh.streamlocal", accept, reject, info);
      reject();
    });

    client.on("end", () => {
      console.log("client disconnected");
    });
  });
}

module.exports = createServer;
