import chalk, { type ChalkInstance } from 'chalk';
import util from 'util';
import fs from 'fs-extra';
import EventEmitter from 'events';
import Stream, { PassThrough, Readable, Transform, Writable } from 'stream';
import path from 'path';

export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly';

type SeparatedWritableOutput = { stdout: string; fileout: string };
type WritableOutput = string | SeparatedWritableOutput;

type DateOutputData = SeparatedWritableOutput & { date: Date };
type LevelOutputData = SeparatedWritableOutput & { level: LogLevel };
type MessageOutputData = SeparatedWritableOutput & { message: unknown[] };

type ColorFunction = ChalkInstance | ((...text: unknown[]) => string);
type LevelColors = { [K in LogLevel]: ColorFunction };
type LevelPrefixes = { [K in LogLevel]: string };
type LevelValues = { [K in LogLevel]: number };
type LevelFilenames = { [K in LogLevel]: string } & { global: string };
type LogWritingData = {
    outputFunction: (options: LoggerOptions, date: DateOutputData, level: LevelOutputData, message: MessageOutputData) => any;
    levelFormatter: (options: LoggerOptions, level: LogLevel) => WritableOutput;
    payloadFormatter: (options: LoggerOptions, message: unknown[]) => WritableOutput;
    dateFormatter: (options: LoggerOptions, date: Date) => WritableOutput;
};

export interface LoggerOptions {
    prefix?: string;
    levelColors: LevelColors;
    levelPrefixes: LevelPrefixes;
    levelValues: LevelValues;
    logDirectory: string;
    levelFilenames: LevelFilenames;
    alwaysLogToConsole: (LogLevel | '*')[];
    noLevelPadding: boolean;
}

export type PartialLoggerOptions = {
    [K in keyof LoggerOptions]?: Partial<LoggerOptions[K]>;
};

interface LoggerStreamRecord {
    stream: Readable;
    level: LogLevel;
    disconnectOnly?: boolean;
    handler?: (chunk: any) => void;
}

function ensureLogfiles(options: LoggerOptions) {
    fs.ensureDirSync(options.logDirectory);
    Object.values(options.levelFilenames).forEach(file => {
        fs.ensureFileSync(path.join(options.logDirectory, file));
    });
}

function deepMerge<T>(target: T, source: Partial<T>): T {
    const output = { ...target };
    for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            output[key] = deepMerge(target[key], source[key]);
        } else {
            output[key] = source[key]!;
        }
    }
    return output;
}

export class Logger {
    public readonly emitter: EventEmitter<{
        log: [{ level: LogLevel; message: unknown[] }];
    }> = new EventEmitter();

    public on = this.emitter.on;
    public off = this.emitter.off;

    // === default options ===
    public options: LoggerOptions = {
        prefix: undefined,
        levelColors: {
            error: chalk.redBright,
            warn: chalk.yellow,
            info: chalk.green,
            http: chalk.blue,
            verbose: chalk.blueBright,
            debug: chalk.blueBright,
            silly: chalk.magentaBright,
        },
        levelPrefixes: {
            error: 'ERROR',
            warn: 'WARN',
            info: 'INFO',
            http: 'HTTP',
            verbose: 'VRBSE',
            debug: 'DEBUG',
            silly: 'SILLY',
        },
        levelValues: {
            error: 0,
            warn: 1,
            info: 2,
            http: 3,
            verbose: 4,
            debug: 5,
            silly: 6,
        },
        levelFilenames: {
            error: 'error.log',
            warn: 'warn.log',
            info: 'info.log',
            http: 'http.log',
            verbose: 'verbose.log',
            debug: 'debug.log',
            silly: 'silly.log',
            global: 'global.log',
        },
        logDirectory: 'logs',
        alwaysLogToConsole: [],
        noLevelPadding: false,
    };

    public writers: LogWritingData = {
        dateFormatter(options, date) {
            const timezoneOffset = date.getTimezoneOffset() * 60000; // ms
            const dateLocal = new Date(date.getTime() - timezoneOffset);
            const dateFormatted = dateLocal.toISOString().slice(0, -1); // strip Z, Z=zulu=UTC
            const datePrefix = dateFormatted.replace('T', ' ');
            return { stdout: chalk.gray(datePrefix), fileout: datePrefix };
        },
        levelFormatter(options, level) {
            const highestLevelLength = Math.max(...Object.values(options.levelPrefixes).map(l => l.length));
            const levelColor = options.levelColors[level];
            const levelPrefix = options.levelPrefixes[level].toUpperCase().padStart(options.noLevelPadding ? 0 : highestLevelLength);
            return { stdout: levelColor(levelPrefix), fileout: levelPrefix };
        },
        payloadFormatter(options, message) {
            let stdout = '';
            let fileout = '';

            message.forEach(thing => {
                if (typeof thing === 'string') {
                    stdout += thing;
                    fileout += thing;
                } else if (thing instanceof Error) {
                    const thingFormatted = thing.stack || thing.toString();
                    stdout += thingFormatted;
                    fileout += thingFormatted;
                } else if (thing instanceof Buffer) {
                    stdout += String(thing);
                    fileout += String(thing);
                } else {
                    stdout += util.inspect(thing, { colors: true, depth: 5 });
                    fileout += util.inspect(thing, { colors: false, depth: 5 });
                }
                stdout += ' ';
                fileout += ' ';
            });

            return { stdout, fileout };
        },
        outputFunction(options, date, level, message) {
            let prefix = `[${options.prefix}]`;
            if (options.prefix == undefined) {
                prefix = '';
            }

            const stdoutPrefix = `${date.stdout} ${level.stdout}${prefix ? ` ${chalk.gray(prefix)}` : ''} `;
            const fileoutPrefix = `${date.fileout} ${level.fileout}${prefix ? ` ${prefix}` : ''} `;

            const prefixNewlines = (prefix: string, text: string) => {
                return text.split("\n").map(line => `${prefix}${line}`).join("\n");
            }

            const finalStdout = `${prefixNewlines(stdoutPrefix, message.stdout)}\n`;
            const finalFileout = `${prefixNewlines(fileoutPrefix, message.fileout)}\n`;

            const logfile = path.join(options.logDirectory, options.levelFilenames[level.level]);
            const globalfile = path.join(options.logDirectory, options.levelFilenames.global);
            ensureLogfiles(options);

            fs.appendFileSync(logfile, finalFileout, { encoding: 'utf-8' });
            fs.appendFileSync(globalfile, finalFileout, { encoding: 'utf-8' });

            const loglevelIndex = process.argv.findIndex(v => v === '--loglevel');
            const consoleLogLevel = (loglevelIndex > 0 ? process.argv[loglevelIndex + 1] : 'info') ?? 'info';
            const consoleLogLevelValue = options.levelValues[consoleLogLevel as LogLevel] ?? Number(consoleLogLevel) ?? options.levelValues.info;

            const levelValue = options.levelValues[level.level];
            if (consoleLogLevelValue >= levelValue || options.alwaysLogToConsole.includes(level.level) || options.alwaysLogToConsole.includes('*')) {
                const out = levelValue < 2 ? process.stderr : process.stdout;
                out.write(finalStdout);
            }
            return finalFileout;
        },
    };

    private streams: LoggerStreamRecord[] = [];

    public getStream(level: LogLevel): Writable {
        const stream = new Transform();

        stream.on('data', chunk => {
            this.log(level, String(chunk));
        });

        this.streams.push({ stream, level });

        return stream;
    }

    public useStream(level: LogLevel, stream: Readable) {
        const handler = (chunk: any) => {
            this.log(level, String(chunk));
        }

        stream.on('data', handler);

        this.streams.push({ stream, level, disconnectOnly: true, handler });

        return stream;
    }

    private formatWritableOutput(input: WritableOutput): SeparatedWritableOutput {
        if (typeof input === 'string') {
            return { stdout: input, fileout: input };
        } else {
            return { stdout: input.stdout, fileout: input.fileout };
        }
    }

    public log(level: LogLevel, ...message: unknown[]) {
        this.emitter.emit('log', { level, message });
        const currentDate = new Date();
        const dateString = this.formatWritableOutput(this.writers.dateFormatter(this.options, currentDate));
        const levelString = this.formatWritableOutput(this.writers.levelFormatter(this.options, level));
        const payloadString = this.formatWritableOutput(this.writers.payloadFormatter(this.options, message));
        this.writers.outputFunction(this.options, { date: currentDate, ...dateString }, { level, ...levelString }, { message, ...payloadString });
    }

    public error(...message: unknown[]) {
        return this.log('error', ...message);
    }
    public warn(...message: unknown[]) {
        return this.log('warn', ...message);
    }
    public info(...message: unknown[]) {
        return this.log('info', ...message);
    }
    public http(...message: unknown[]) {
        return this.log('http', ...message);
    }
    public verbose(...message: unknown[]) {
        return this.log('verbose', ...message);
    }
    public debug(...message: unknown[]) {
        return this.log('debug', ...message);
    }
    public silly(...message: unknown[]) {
        return this.log('silly', ...message);
    }

    public destroyAllStreams() {
        this.streams.forEach(stream => {
            if (stream.disconnectOnly && stream.handler) {
                stream.stream.off('data', stream.handler);
            } else {
                stream.stream.destroy();
            }
        });
    }

    public constructor(prefix?: string, options?: PartialLoggerOptions) {
        this.options.prefix = prefix;
        if (options) {
            this.options = deepMerge(this.options, options as Partial<LoggerOptions>);
        }
    }
}

export const log = new Logger();
export const error = log.error;
export const warn = log.warn;
export const info = log.info;
export const http = log.http;
export const debug = log.debug;
export const verbose = log.verbose;
export const silly = log.silly;
