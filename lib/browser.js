var debug = require("local-debug")('browser');
var http = require("http");
var browserify = require("browserify");
var routeMap = require("route-map");
var fs = require("fs");
var path = require("path");
var resumer = require("resumer");
var format = require("stream-format");
var formatText = require("format-text");
var concat = require("concat-stream");
var glob = require("glob").sync;
var parseUserAgent = require("user-agent-parser");
var prettifyError = require("prettify-error");
var WebSocket = require("faye-websocket");
var mime = require("mime");
var execFirst = require("./exec-first");

var nodeTemplate = require("./node-template");
var nodeReporter = require("./node-reporter");
var transforms = require('./browserify-transforms');

var passTemplate = nodeTemplate('browser-passed-result');
var failTemplate = nodeTemplate('browser-failed-result');
var browserTemplate = nodeTemplate('browser-error-browser');
var errorTemplate = nodeTemplate('browser-error');
var errorNoStackTemplate = nodeTemplate('browser-error-no-stack');
var onSourceCodeChange = require("pubsub")();
var customFrameURL, matchURL, read;

var routes = {
  '/assets/app.js': app,
  '/assets/run.js': run,
  '/assets/:file': provaAsset,
  '/run': frame,
  '/': index
};

var templates = glob(provaPath('../../templates/*.html')).map(function (f) {
  return { name: path.basename(f, '.html'), filename: f };
});

module.exports = beforeStart;

function beforeStart (files, command) {
  if (!command.exec) return start(files, command);

  execFirst(command.exec, function () {
    start(files, command);
  });
}

function start (files, command) {
  var http = require('http');
  var server = http.createServer(route).listen(command.port, command.host);
  var restartNotification = JSON.stringify({ restart: true });
  var sockets = [];

  read = transforms(files, command);
  read.on('update', onSourceCodeChange.publish);

  if (command.frame) {
    customFrameURL = path.join('/assets/in', command.frame);
    routes[customFrameURL] = customFrame(command.frame);
  }

  routes['/assets/in/:filename([\\w\\.\\/-]+)'] = localAsset;
  routes['/restart'] = restart;

  matchURL = routeMap(routes);

  server.on('upgrade', function(request, socket, body) {
    var ws;
    var ind;

    if (WebSocket.isWebSocket(request)) {
      ws = new WebSocket(request, socket, body);
      ind = sockets.push(ws) - 1;

      onSourceCodeChange.subscribe(notify);

      ws.send(JSON.stringify({ start: true, url: customFrameURL || '/run' }));
      ws.on('message', onMessage);
      ws.on('close', function(event) {
        ws = null;
        sockets[ind] = undefined;
        onSourceCodeChange.unsubscribe(notify);
      });
    }

    function notify () {
      ws.send(restartNotification);
    }

  });

  debug('Visit %s:%s with a browser to start running the tests.', command.host, command.port);

  function onMessage (msg) {
    msg = JSON.parse(msg.data);

    if (msg.result) {
      outputResult(msg);
      if (command.quit) process.exit(msg.failed);
      return;
    }

    if (msg.fail) return outputError(msg);
  }

  function restart (request, response) {
    response.write('restartiiiinnnnggg....\n');

    var i = 0;

    sockets.forEach(function (ws) {
      if (!ws) return;
      ws.send(restartNotification);
      i++;

      response.write(i + '\n');
    });

    response.end('done\n');
  }
}

function route (req, res) {
  var match = matchURL(req.url);
  if (!match) return notfound().pipe(res);
  match.fn(req, res, match);
};

function provaFile (file) {
  return fs.createReadStream(provaPath('../../app/' + file));
}

function provaAsset (req, res, match) {
  setContentType(req, res);
  provaFile(match.params.file).on('error', function (error) {
    notfound().pipe(res);
  }).pipe(res);
}

function localAsset (req, res, match) {
  var filename = match.params.filename;
  setContentType(req, res);

  localFile(filename).on('error', function (error) {
    notfound().pipe(res);
  }).pipe(res);
}

function localFile (filename) {
  return fs.createReadStream(filename);
}

function index (req, res) {
  var waiting = format({
    message: 'loading'
  });

  fs.createReadStream(provaPath('../../templates/waiting.html'))
    .pipe(waiting);

  var render = format({
    layout: waiting
  });

  provaFile('index.html').pipe(render);
  render.pipe(res);
}

function build (filename) {
  var b = browserify();
  b.add(filename);
  return b;
}

function app (req, res) {
  convertTemplates();
  setContentType(req, res);
  build(provaPath('../../app/index.js')).bundle().pipe(res);
}

function run (req, res) {
  var sourcemaps;
  var ind;

  var write = concat(function (build) {
    var str = build.toString();
    ind = str.indexOf('//# sourceMappingURL');
    str = str.slice(0, ind) + '\n\nwindow.__source_code = window.parent.__source_code = ' + JSON.stringify(str.slice(0, ind)) + ';\n\n' + str.slice(ind);
    setContentType(req, res);
    res.end(str);
  });

  read.bundle({ debug: true }).on('error', function (error) {
    debug('Failed to browserify the source code. We\'re probably missing a module required. The error was:');
    process.stderr.write('\n    ');
    console.error(prettifyError(error, 0));
  }).pipe(write);
}

function notfound () {
  return resumer().queue('Not Found').end();
}

function frame (req, res) {
  provaFile('frame.html').pipe(res);
}

function convertTemplates () {
  var content = templates.map(function (template) {
    return {
      name: template.name,
      html: fs.readFileSync(template.filename).toString()
    };
  });

  content = content.map(function (template) {
    return 'exports["' + template.name + '"] = ' + JSON.stringify(template.html);
  });

  fs.writeFileSync(provaPath('../../app/templates.js'), content.join('\n'));
}

function provaPath (p) {
  return path.join(__filename, p);
}

process.on('uncaughtException', function (error) {
  console.error('\n', prettifyError(error) || error);
});

function outputError (msg) {
  var fail = msg.fail;
  var error = {
    message: fail.name,
    stack: fail.stack
  };

  console.log(formatText(error.stack ? errorTemplate : errorNoStackTemplate, {
    browser: formatUserAgent(msg.userAgent),
    title: fail.test,
    diff: diff(fail),
    error: nodeReporter.tab(prettifyError(error, undefined, fail.source) || '', '    ')
  }));
}

function outputResult (msg) {
  var failed = msg.result.failed;
  var template = failed ? failTemplate : passTemplate;

  console.log(formatText(template, msg.result) + '  ' + formatUserAgent(msg.userAgent));
}

function formatUserAgent (rawUserAgent) {
  var userAgent = parseUserAgent(rawUserAgent);

  return formatText(browserTemplate, {
    browser: userAgent.browser.name || '?',
    browserVersion: userAgent.browser.major || '?',
    engine: userAgent.engine.name || '?',
    engineVersion: userAgent.engine.version || '?',
    os: userAgent.os.name || '?',
    osVersion: userAgent.os.version || '?'
  })
}

function diff (fail) {
 return nodeReporter.diff(fail).slice(1).split('\n').map(function (line) {
   return line.slice(4);
 }).join('\n');
}

function customFrame (filename) {
  return function (req, res) {
    fs.readFile(filename, function (error, bf) {
      if (error) {
        debug('Error: Failed to read %s, specified as custom frame.', filename);
        console.error(error);
        return;
      };

      var html = bf.toString();
      html += '<script type="text/javascript" src="/assets/run.js"></script>';
      setContentType(req, res);
      res.end(html);
    });
  };
}

function setContentType (req, res) {
  res.setHeader('Content-Type', mime.lookup(req.url));
}
