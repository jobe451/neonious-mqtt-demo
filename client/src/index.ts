import * as fs from 'fs';
import * as path from 'path';
import * as express from 'express';
import {Request, Response} from 'express';
import {Logger} from "./Logger";
import {WaterTap, TapConfig} from "./WaterTap";

const args = process.argv;
const configFile = (args[2] ? args[2] : path.join(__dirname, '..', 'default.json'));
const settings = JSON.parse(fs.readFileSync(configFile, "utf8"));
const tapList = new Map();
const defaultPort = 3000;

let logger = Logger.getInstance();
logger.enableLogToConsole(isTrue(settings.logToConsole) ? true : false);


const enableGPIO = isTrue(settings.enableGPIO);
const port = (isNaN(parseInt(settings.port)) ? defaultPort : parseInt(settings.port));
logger.log("configFile", configFile);

initTaps();
var app = express();

function run() {
    app.get('/runWater', (req: Request, res: Response) => {
        runWater(req, res);
    });

    app.get('/cancelWater', (req: Request, res: Response) => {
        cancelWater(req, res);
    });

    app.get('/statusWater', (req: Request, res: Response) => {
        statusWater(req, res);
    });

    app.get('/getAllStatus', (req: Request, res: Response) => {
        getAllStatus(req, res);
    });

    app.get('/getConfig', (req: Request, res: Response) => {
        getConfig(req, res);
    });

    app.listen(port, function () {
        logger.info('Example app listening on port', port);
    });
}

function statusWater(req: Request, res: Response): void {
    let tap = getTap(req, res);
    if (!tap) {
        return;
    }

    res.send(tap.isWaterRunning() ? "RUNNING" : "NOT RUNNING").end();
}


function getAllStatus(req: Request, res: Response): void {
    let responseList = [] as Array<any>;

    for (let i in settings.taps) {
        let tapName = settings.taps[i].name;
        let tap = tapList.get(tapName.trim().toLowerCase()) as WaterTap;
        responseList.push({name: tapName, status: tap.getStatus()});
    }

    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(responseList)).end();
}

function getConfig(req: Request, res: Response): void {
    let tapSettings = JSON.stringify(settings.taps);
    res.setHeader('Content-Type', 'application/json');
    res.send(tapSettings).end();
}

function cancelWater(req: Request, res: Response): void {
    let tap = getTap(req, res);
    if (!tap) {
        return;
    }

    tap.cancelRunningWater();;

    res.send('OK').end();
}

function runWater(req: Request, res: Response): void {
    if (!req.query.seconds) {
        res.status(500);
        res.send("ERROR 500, get parameter seconds missing");
        res.end();
        return;
    }

    let seconds = parseInt(req.query.seconds);
    if (isNaN(seconds)) {
        res.status(500);
        res.send("ERROR 500, seconds is not a number");
        res.end();
        return;
    }

    let tap = getTap(req, res);
    if (!tap) {
        return;
    }

    let success = tap.runForXSeconds(seconds);

    res.status(success ? 200 : 500);
    res.send(success ? "OK" : "FAILED").end();
}

function getTap(req: Request, res: Response): WaterTap | null {
    if (!req.query.tapName) {
        res.status(500);
        res.send("ERROR 500, get parameter tapName missing");
        res.end();
        return null;
    }

    let tap = tapList.get(req.query.tapName.trim().toLowerCase()) as WaterTap;
    if (!tap) {
        res.status(500);
        res.send("ERROR 500, tapName unknown");
        res.end();
        return null;
    }

    return tap;
}

function initTaps () {
    if (!settings.taps) {
        throw "taps list is not defined in config";
    }
    if (settings.taps instanceof Array === false) {
        throw "taps list is not an array in config";
    }

    settings.taps.forEach((element: any) => {
        initTap(element);
    });

}

function initTap (element: any) {
    if (!element.name || typeof(element.name) !== "string") {
        throw "one tap is missing proper name";
    }
    else if (!element.maxSecondsPer24Hours || typeof(element.maxSecondsPer24Hours) !== "number") {
        throw "one tap is missing proper maxSecondsPer24Hours";
    }
    else if (!element.gpioNumber || typeof(element.gpioNumber) !== "number") {
        throw "one tap is missing proper gpioNumber";
    }

    let configuration = {
        enableGPIO: enableGPIO,
        maxSecondsPer24Hours: element.maxSecondsPer24Hours,
        gpioNumber: element.gpioNumber,
    } as TapConfig;

    let tap = new WaterTap(element.name, configuration);
    tapList.set(element.name.trim().toLowerCase(), tap);
}

function isTrue (value: string | boolean) {
    if(typeof(value) === "boolean") {
        return value
    }
    if(typeof(value) === "string") {
        if (value.trim().toLowerCase() === "true") {
            return true;
        }
    }
    return false;    
}

run();