import * as aribts from 'aribts';
import * as fs from 'fs';
import * as path from 'path';
import 'reflect-metadata';
import { install } from 'source-map-support';
import DropCheckerModel from './model/operator/recording/DropCheckerModel';
import ILoggerModel from './model/ILoggerModel';
import container from './model/ModelContainer';
import cliProgress from 'cli-progress';
import stream from 'stream';
import * as containerSetter from './model/ModelContainerSetter';
install();

containerSetter.set(container);

class DropCheck {
    private srcM2tsPath: string;
    private dstLogDirPath: string;

    constructor() {
        if (process.argv.length < 3) {
            console.error('使用方法: npm run dropcheck INPUT.m2ts [OUTPUT_DIR]');
            process.exit(1);
        }

        this.srcM2tsPath = process.argv[2];
        this.dstLogDirPath = process.argv[3];
    }

    /**
     * run
     */
    public async run(): Promise<void> {
        console.log('ドロップチェック開始');

        const logger = container.get<ILoggerModel>('ILoggerModel');
        logger.initialize();

        const checker = new DropCheckerModel(logger);

        const readableStream = fs.createReadStream(this.srcM2tsPath);
        const transformStream = this._createTransformStream();
        readableStream.pipe(transformStream);

        await new Promise<void>((resolve, reject) => {
            readableStream.on('end', () => {
                // DropCheckerModel の実装上、終了しているかの確認を外側からするのには難がある
                // 大まかに待った後で getResult() で待機する
                resolve();
            });
            readableStream.on('error', (err: any) => {
                reject(err);
            });

            // v2.6.20 現在の実装では m2ts のパスはログファイルの名前の決定のみに使用される
            // データは stream から読み取られる
            checker
                .start(this.dstLogDirPath || path.dirname(this.srcM2tsPath), this.srcM2tsPath, transformStream)
                .catch((err: any) => {
                    reject(err);
                });
        }).catch(async (err: any) => {
            console.error('ドロップチェックに失敗しました');
            console.error(err);

            await checker.stop().catch(() => {});
            transformStream.end();
            transformStream.unpipe();
            readableStream.close();
            process.exit(1);
        });

        try {
            // 結果が書き出されるまで待つ
            const dropResult = await checker.getResult();

            // 解放
            checker.stop();
            transformStream.end();
            transformStream.unpipe();
            readableStream.close();

            console.log('ドロップチェック完了');
            this._printDropResult(dropResult);
        } catch (err: any) {
            console.error('解放処理またはドロップ情報の読み込みに失敗しました');
            console.error(err);

            await checker.stop().catch(() => {});
            transformStream.end();
            transformStream.unpipe();
            readableStream.close();
            process.exit(1);
        }
    }

    /**
     * create transform stream for progress bar
     */
    private _createTransformStream(): stream.Transform {
        const size = fs.statSync(this.srcM2tsPath).size;
        let bytesRead = 0;
        let count = 0;

        const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        progressBar.start(size, 0);

        return new stream.Transform({
            transform: function (chunk, _, done) {
                bytesRead += chunk.length;

                if (++count === 100) {
                    progressBar.update(bytesRead);
                    count = 0;
                }

                this.push(chunk);
                done();
            },
            flush: function (done) {
                progressBar.update(size);
                progressBar.stop();

                done();
            },
        });
    }

    /**
     * print drop result
     */
    private _printDropResult(dropResult: aribts.Result) {
        let error = 0;
        let drop = 0;
        let scrambling = 0;

        for (const pid in dropResult) {
            error += dropResult[pid].error;
            drop += dropResult[pid].drop;
            scrambling += dropResult[pid].scrambling;
        }

        console.log('error      : ' + error);
        console.log('drop       : ' + drop);
        console.log('scrambling : ' + scrambling);
    }
}

new DropCheck().run();
