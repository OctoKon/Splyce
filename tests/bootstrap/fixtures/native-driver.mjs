import { createServer } from "node:http";
const port = Number(
  process.argv.find((arg) => arg.startsWith("--port="))?.slice(7),
);
createServer((req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"value":{"ready":true}}');
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const mode = body.capabilities?.alwaysMatch?.probeMode;
    const send = () => {
      res.writeHead(201, {
        "content-type": "application/json",
        "x-probe": "preserved",
        "x-probe-request":
          req.method === "POST" &&
          req.url === "/session" &&
          ["immediate", "delay", "stall"].includes(mode)
            ? "preserved"
            : "invalid",
      });
      if (mode === "stall") res.write('{"value":');
      else res.end('{"value":{"fixture":"exact"}}');
    };
    if (mode === "delay") setTimeout(send, 120);
    else send();
  });
}).listen(port, "127.0.0.1");
