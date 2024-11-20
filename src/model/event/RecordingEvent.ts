import * as events from 'events';
import { inject, injectable } from 'inversify';
import * as apid from '../../../api';
import Recorded from '../../db/entities/Recorded';
import Reserve from '../../db/entities/Reserve';
import ILogger from '../ILogger';
import ILoggerModel from '../ILoggerModel';
import IRecordingEvent from './IRecordingEvent';

@injectable()
class RecordingEvent implements IRecordingEvent {
    private log: ILogger;
    private emitter: events.EventEmitter = new events.EventEmitter();

    constructor(@inject('ILoggerModel') logger: ILoggerModel) {
        this.log = logger.getLogger();
    }

    /**
     * 録画準備開始イベント発行
     * @param reserve: Reserve
     */
    public emitStartPrepRecording(reserve: Reserve): void {
        this.emitter.emit(RecordingEvent.START_PREP_RRECORDING_EVENT, reserve);
    }

    /**
     * 録画準備キャンセルイベント発行
     * @param reserve: Reserve
     */
    public emitCancelPrepRecording(reserve: Reserve): void {
        this.emitter.emit(RecordingEvent.CANCEL_PREP_RRECORDING_EVENT, reserve);
    }

    /**
     * 録画準備失敗イベント発行
     * @param reserve: Reserve
     */
    public emitPrepRecordingFailed(reserve: Reserve): void {
        this.emitter.emit(RecordingEvent.PREP_RECORDING_FAILED_EVENT, reserve);
    }

    /**
     * 録画開始イベント発行
     * @param reserve: Reserve
     */
    public emitStartRecording(reserve: Reserve, recorded: Recorded): void {
        this.emitter.emit(RecordingEvent.START_RECORDING_EVENT, reserve, recorded);
    }

    /**
     * 録画失敗イベント発行
     * @param reserve: Reserve
     * @param recorded: Recorded | null
     */
    public emitRecordingFailed(reserve: Reserve, recorded: Recorded | null): void {
        this.emitter.emit(RecordingEvent.RECORDING_FAILED_EVENT, reserve, recorded);
    }

    /**
     * 録画リトライオーバーイベント発行
     * @param reserve: Reserve
     */
    public emitRecordingRetryOver(reserve: Reserve): void {
        this.emitter.emit(RecordingEvent.RECORDING_RETRY_OVER_EVENT, reserve);
    }

    /**
     * 録画完了イベント発行
     * @param reserve: Reserve
     * @param recorded: Recorded
     * @param isNeedDeleteReservation: boolean true 予約の削除が必要
     */
    public emitFinishRecording(reserve: Reserve, recorded: Recorded, isNeedDeleteReservation: boolean): void {
        this.emitter.emit(RecordingEvent.FINISH_RECORDING_EVENT, reserve, recorded, isNeedDeleteReservation);
    }

    /**
     * イベントリレーによる予約依頼イベントの発行
     * @param programs: { programId: apid.ProgramId; parentReserve: Reserve }[]
     */
    public emitEventRelay(programs: { programId: apid.ProgramId; parentReserve: Reserve }[]): void {
        this.emitter.emit(RecordingEvent.EVENT_RELAY_EVENT, programs);
    }

    /**
     * 録画準備開始イベント登録
     * @param callback: (reserve: Reserve) => void
     */
    public setStartPrepRecording(callback: (reserve: Reserve) => void): void {
        this.emitter.on(RecordingEvent.START_PREP_RRECORDING_EVENT, async (reserve: Reserve) => {
            try {
                await callback(reserve);
            } catch (err: any) {
                this.log.system.error(err);
            }
        });
    }

    /**
     * 録画準備キャンセルイベント登録
     * @param callback: (reserve: Reserve) => void
     */
    public setCancelPrepRecording(callback: (reserve: Reserve) => void): void {
        this.emitter.on(RecordingEvent.CANCEL_PREP_RRECORDING_EVENT, async (reserve: Reserve) => {
            try {
                await callback(reserve);
            } catch (err: any) {
                this.log.system.error(err);
            }
        });
    }

    /**
     * 録画準備失敗イベント登録
     * @param callback: (reserve: Reserve) => void
     */
    public setPrepRecordingFailed(callback: (reserve: Reserve) => void): void {
        this.emitter.on(RecordingEvent.PREP_RECORDING_FAILED_EVENT, async (reserve: Reserve) => {
            try {
                await callback(reserve);
            } catch (err: any) {
                this.log.system.error(err);
            }
        });
    }

    /**
     * 録画開始イベント登録
     * @param callback: (reserve: Reserve, recorded: Recorded) => void
     */
    public setStartRecording(callback: (reserve: Reserve, recorded: Recorded) => void): void {
        this.emitter.on(RecordingEvent.START_RECORDING_EVENT, async (reserve: Reserve, recorded: Recorded) => {
            try {
                await callback(reserve, recorded);
            } catch (err: any) {
                this.log.system.error(err);
            }
        });
    }

    /**
     * 録画失敗イベント登録
     * @param callback: (reserve: Reserve, recorded: Recorded | null) => void
     */
    public setRecordingFailed(callback: (reserve: Reserve, recorded: Recorded | null) => void): void {
        this.emitter.on(RecordingEvent.RECORDING_FAILED_EVENT, async (reserve: Reserve, recorded: Recorded | null) => {
            try {
                await callback(reserve, recorded);
            } catch (err: any) {
                this.log.system.error(err);
            }
        });
    }

    /**
     * 録画リトライオーバーイベント登録
     * @param callback: (reserve: Reserve) => void
     */
    public setRecordingRetryOver(callback: (reserve: Reserve) => void): void {
        this.emitter.on(RecordingEvent.RECORDING_RETRY_OVER_EVENT, async (reserve: Reserve) => {
            try {
                await callback(reserve);
            } catch (err: any) {
                this.log.system.error(err);
            }
        });
    }

    /**
     * 録画完了イベント登録
     * @param callback: (reserve: Reserve, rrecorded: Recorded, isNeedDeleteReservation: boolean) => void
     */
    public setFinishRecording(
        callback: (reserve: Reserve, recorded: Recorded, isNeedDeleteReservation: boolean) => void,
    ): void {
        this.emitter.on(
            RecordingEvent.FINISH_RECORDING_EVENT,
            async (reserve: Reserve, recorded: Recorded, isNeedDeleteReservation: boolean) => {
                try {
                    await callback(reserve, recorded, isNeedDeleteReservation);
                } catch (err: any) {
                    this.log.system.error(err);
                }
            },
        );
    }

    /**
     * イベントリレーによる予約依頼イベントへの登録
     * @param callback: (programs: { programId: apid.ProgramId; parentReserve: Reserve }[]) => void
     */
    public setEventRelay(callback: (programs: { programId: apid.ProgramId; parentReserve: Reserve }[]) => void): void {
        this.emitter.on(
            RecordingEvent.EVENT_RELAY_EVENT,
            async (programs: { programId: apid.ProgramId; parentReserve: Reserve }[]) => {
                try {
                    await callback(programs);
                } catch (err: any) {
                    this.log.system.error(err);
                }
            },
        );
    }
}

namespace RecordingEvent {
    export const START_PREP_RRECORDING_EVENT = 'StartPrepRecording';
    export const CANCEL_PREP_RRECORDING_EVENT = 'CancelPrepRecording';
    export const PREP_RECORDING_FAILED_EVENT = 'PrepRecordingFailed';
    export const START_RECORDING_EVENT = 'StartRecordingEvent';
    export const RECORDING_FAILED_EVENT = 'RecordingFailedEvent';
    export const RECORDING_RETRY_OVER_EVENT = 'RecordingRetryOverEvent';
    export const FINISH_RECORDING_EVENT = 'FinishRecordingEvent';
    export const EVENT_RELAY_EVENT = 'EventRelayEvent';
}

export default RecordingEvent;
