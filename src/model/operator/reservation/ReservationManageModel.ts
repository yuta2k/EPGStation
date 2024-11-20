import { inject, injectable } from 'inversify';
import * as apid from '../../../../api';
import * as mapid from '../../../../node_modules/mirakurun/api';
import Channel from '../../../db/entities/Channel';
import Program from '../../../db/entities/Program';
import Reserve from '../../../db/entities/Reserve';
import DateUtil from '../../../util/DateUtil';
import StrUtil from '../../../util/StrUtil';
import Util from '../../../util/Util';
import IChannelDB from '../../db/IChannelDB';
import IProgramDB, { ProgramWithOverlap } from '../../db/IProgramDB';
import IReserveDB, { IFindTimeRangesOption, IReserveTimeOption } from '../../db/IReserveDB';
import IRuleDB, { RuleWithCnt } from '../../db/IRuleDB';
import IReserveEvent, { IReserveUpdateValues } from '../../event/IReserveEvent';
import IConfigFile from '../../IConfigFile';
import IConfiguration from '../../IConfiguration';
import IExecutionManagementModel from '../../IExecutionManagementModel';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import IReserveOptionChecker from '../IReserveOptionChecker';
import IReservationManageModel from './IReservationManageModel';
import Tuner from './Tuner';

interface ReserveDiffData {
    reserve: Reserve;
    isChecked: boolean;
}

@injectable()
class ReservationManageModel implements IReservationManageModel {
    private log: ILogger;
    private config: IConfigFile;
    private executeManagementModel: IExecutionManagementModel;
    private optionChecker: IReserveOptionChecker;
    private reserveDB: IReserveDB;
    private channelDB: IChannelDB;
    private programDB: IProgramDB;
    private ruleDB: IRuleDB;
    private reserveEvent: IReserveEvent;
    private tuners: Tuner[] = [];
    private broadcastStatus: apid.BroadcastStatus = {
        GR: false,
        BS: false,
        CS: false,
        SKY: false,
    };

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('IConfiguration') configuration: IConfiguration,
        @inject('IExecutionManagementModel') executeManagementModel: IExecutionManagementModel,
        @inject('IReserveOptionChecker') optionChecker: IReserveOptionChecker,
        @inject('IReserveDB') reserveDB: IReserveDB,
        @inject('IChannelDB') channelDB: IChannelDB,
        @inject('IProgramDB') programDB: IProgramDB,
        @inject('IRuleDB') ruleDB: IRuleDB,
        @inject('IReserveEvent') reserveEvent: IReserveEvent,
    ) {
        this.log = logger.getLogger();
        this.config = configuration.getConfig();
        this.executeManagementModel = executeManagementModel;
        this.optionChecker = optionChecker;
        this.reserveDB = reserveDB;
        this.channelDB = channelDB;
        this.programDB = programDB;
        this.ruleDB = ruleDB;
        this.reserveEvent = reserveEvent;
    }

    /**
     * チューナ情報をセット
     * @param tuners: TunerDevice[]
     */
    public setTuners(tuners: mapid.TunerDevice[]): void {
        this.tuners = tuners.map(tuner => {
            // set this.broadcastStatus
            for (const key in this.broadcastStatus) {
                if (tuner.types.indexOf(<mapid.ChannelType>key) !== -1) {
                    (<any>this.broadcastStatus)[key] = true;
                }
            }

            return new Tuner(tuner);
        });
    }

    /**
     * 放送波の状態を返す
     * @return apid.BroadcastStatus
     */
    public getBroadcastStatus(): apid.BroadcastStatus {
        return this.broadcastStatus;
    }

    /**
     * 手動予約追加
     */
    public async add(option: apid.ManualReserveOption): Promise<apid.ReserveId> {
        this.log.system.info(
            'add reservation' + (typeof option.programId !== 'undefined' ? `: ${option.programId}` : ''),
        );

        // オプションチェック
        if (this.checkManualReserveOption(option) === false) {
            this.log.system.error('add reservation option error');
            throw new Error('AddReservationOptionError');
        }

        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(ReservationManageModel.ADD_RESERVE_PRIORITY);
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        // 予約情報の生成
        let newReserve: Reserve;
        try {
            if (typeof option.programId === 'undefined') {
                newReserve = await this.createManualReserveWithSpecifiedTime(option);
            } else {
                newReserve = await this.createManualReserveWithProgramId(option);
            }
        } catch (err) {
            // 予約情報の生成失敗
            finalize();
            throw err;
        }

        // 追加する予約情報が競合するかチェック
        await this.checkSingleReserveConflict(newReserve).catch(err => {
            finalize();
            throw err;
        });

        // 追加
        const insertedId = await this.reserveDB.insertOnce(newReserve).catch(err => {
            this.log.system.info(`add reservation error: ${option.programId}`);
            this.log.system.error(err);
            finalize();
            throw new Error('ReservationManageModelAddReserveError');
        });
        newReserve.id = insertedId;

        // 完了したのでロック解除
        finalize();

        this.log.system.info(
            `successful add reservation: ${insertedId}` +
                (typeof option.programId !== 'undefined' ? `, ${option.programId}` : ''),
        );

        // イベント発行
        this.reserveEvent.emitUpdated({
            insert: [newReserve],
            isSuppressLog: false,
        });

        return insertedId;
    }

    /**
     * イベントリレーによる予約追加
     * @param programId: apid.ProgramId リレー先の program id
     * @param parentReserve: Reserve リレー元の予約情報
     * @returns Promise<apid.ReserveId | null>
     *              apid.ReserveId: 予約 Id. 予約が追加された場合返される
     *              null: すでに予約済み
     */
    public async addEventRelay(programId: apid.ProgramId, parentReserve: Reserve): Promise<apid.ReserveId | null> {
        this.log.system.info(`add event relay. reserveId: ${parentReserve.id}, programId: ${programId}`);

        // すでに録画されていないか検索する
        const reservedPrograms = await this.reserveDB.findProgramId(programId);
        if (reservedPrograms.length > 0) {
            this.log.system.warn(`already reserved program. reserveId: ${parentReserve.id}, programId: ${programId}`);
            return null;
        }

        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(ReservationManageModel.ADD_RESERVE_PRIORITY);
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        // 予約情報を生成する
        const newReserve = await this.createEventRelayReserve(programId, parentReserve).catch(err => {
            finalize();
            throw err;
        });

        // 追加する予約情報が競合するかチェック
        await this.checkSingleReserveConflict(newReserve).catch(err => {
            finalize();
            throw err;
        });

        // 追加
        const insertedId = await this.reserveDB.insertOnce(newReserve).catch(err => {
            this.log.system.info(`add reservation error: reserveId: ${parentReserve.id}, programId: ${programId}`);
            this.log.system.error(err);
            finalize();
            throw new Error('ReservationManageModelAddReserveError');
        });
        newReserve.id = insertedId;

        // 完了したのでロック解除
        finalize();

        this.log.system.info(
            `successful add event relay. reserveId: ${parentReserve.id}, newReserveId: ${newReserve.id} programId: ${programId}`,
        );

        // イベント発行
        this.reserveEvent.emitUpdated({
            insert: [newReserve],
            isSuppressLog: false,
        });

        return insertedId;
    }

    /**
     * Program Id 指定の手動予約の予約情報を生成する
     * @param option: apid.ManualReserveOption 手動予約オプション
     * @returns: Promise<Reserve> 予約情報
     */
    private async createManualReserveWithProgramId(option: apid.ManualReserveOption): Promise<Reserve> {
        // program id 指定の手動予約じゃない
        if (typeof option.programId === 'undefined') {
            this.log.system.error('failed to create manual reserve. program id is undefined.');
            throw new Error('FailedToCreateManualReserve');
        }

        // すでに予約済みでないかチェック
        try {
            const r = await this.reserveDB.findProgramId(option.programId);
            if (r.length > 0) {
                // すでに予約済み
                this.log.system.error(`program is reserved: ${option.programId}`);
                throw new Error('ReservationManageModelReservedError');
            }
        } catch (err: any) {
            this.log.system.error('check reserved programs error');
            throw new Error('ReservationManageModelCheckReservedProgramError');
        }

        // 予約対象の番組情報を取得する
        let program: Program | null = null;
        try {
            // 番組情報取得
            program = await this.programDB.findId(option.programId);
        } catch (err: any) {
            this.log.system.error(`program is not found: ${option.programId}`);
            throw err;
        }

        if (program === null) {
            // 指定された program id の番組情報が見つからなかった
            this.log.system.info(`program is not found: ${option.programId}`);
            throw new Error('ProgramIsNotFound');
        }

        // 予約情報生成
        const newReserve = new Reserve();
        newReserve.updateTime = new Date().getTime();
        this.setProgramToReserve(newReserve, program);

        this.setManualReserveOption(option, newReserve);

        return newReserve;
    }

    /**
     * 時刻指定の手動予約の予約情報を生成する
     * @param option: apid.ManualReserveOption 手動予約オプション
     * @returns: Promise<Reserve> 予約情報
     */
    private async createManualReserveWithSpecifiedTime(option: apid.ManualReserveOption): Promise<Reserve> {
        // 時刻指定の手動予約ではない
        if (typeof option.programId !== 'undefined' || typeof option.timeSpecifiedOption === 'undefined') {
            this.log.system.error('time specified option error');
            throw new Error('TimeSpecifiedOptionIsUndefined');
        }

        // name チェック
        if (typeof option.timeSpecifiedOption.name === 'undefined') {
            this.log.system.error('name is undefined');
            throw new Error('NameIsUndefinedError');
        }

        // 時刻チェック
        if (option.timeSpecifiedOption.endAt <= new Date().getTime()) {
            this.log.system.error('timeSpecifiedOption error');
            throw new Error('TimeSpecifiedOptionError');
        }

        // すでに同じ条件で予約済みでないかチェック
        const oldReserve = await this.reserveDB.findTimeSpecification(option.timeSpecifiedOption).catch(err => {
            this.log.system.error('get old reservation error');
            throw err;
        });
        if (oldReserve !== null) {
            this.log.system.error('conflict add reservation');
            throw new Error('AddReservationConflictError');
        }

        // channel 情報取得
        const channel = await this.channelDB.findId(option.timeSpecifiedOption.channelId).catch(err => {
            if (typeof option.timeSpecifiedOption !== 'undefined') {
                this.log.system.error(`channelId find error: ${option.timeSpecifiedOption.channelId}`);
            }
            this.log.system.error(err);
            throw new Error('ReservationManageModelFindChannelError');
        });
        if (channel === null) {
            this.log.stream.error(`channelId is not found: ${option.timeSpecifiedOption.channelId}`);
            throw new Error('eservationManageModelFindChannelIsNotFound');
        }

        // 予約情報の作成
        const newReserve = new Reserve();
        newReserve.isEventRelay = true;
        newReserve.updateTime = new Date().getTime();
        newReserve.isTimeSpecified = true;
        newReserve.name = StrUtil.toDBStr(option.timeSpecifiedOption.name);
        newReserve.halfWidthName = StrUtil.toHalf(newReserve.name);
        newReserve.startAt = option.timeSpecifiedOption.startAt;
        newReserve.endAt = option.timeSpecifiedOption.endAt;
        newReserve.channelId = channel.id;
        newReserve.channel = channel.channel;
        newReserve.channelType = channel.channelType;

        this.setManualReserveOption(option, newReserve);

        return newReserve;
    }

    /**
     * 手動予約のオプション情報をセットする
     * @param option: apid.ManualReserveOption 手動予約オプション
     * @param newReserve: Reserve セット対象の予約情報
     */
    private setManualReserveOption(option: apid.ManualReserveOption, newReserve: Reserve): void {
        // option から必要な情報をセットする
        newReserve.allowEndLack = option.allowEndLack;
        if (typeof option.tags !== 'undefined') {
            newReserve.tags = JSON.stringify(option.tags);
        }
        if (typeof option.saveOption !== 'undefined') {
            this.setSaveOptionToReserve(newReserve, option.saveOption);
        }
        if (typeof option.encodeOption !== 'undefined') {
            this.setEncodeOptionToReserve(newReserve, option.encodeOption);
        }
    }

    /**
     * イベントリレー用の予約情報を生成する
     * @param programId: apid.ProgramId リレー先の program id
     * @param parentReserve: Reserve リレー元の予約情報
     * @returns: Promise<Reserve> 作成した予約情報
     */
    private async createEventRelayReserve(programId: apid.ProgramId, parentReserve: Reserve): Promise<Reserve> {
        const newReserve = new Reserve();
        newReserve.isEventRelay = true;
        newReserve.updateTime = new Date().getTime();

        // 番組情報を検索する
        let program: Program | null = null;
        try {
            program = await this.programDB.findId(programId);
        } catch (err: any) {
            // 検索に失敗
            this.log.system.error(`program is not found. ${programId}`);
            throw err;
        }

        if (program === null) {
            // 指定された program id の番組が存在しない
            this.log.system.error(`program is not found. ${programId}`);
            throw new Error('ProgramIsNotFound');
        }

        // 取得した番組情報をセットする
        this.setProgramToReserve(newReserve, program);

        // リレー元の予約情報から必要な情報をセットする
        newReserve.ruleId = parentReserve.ruleId;
        newReserve.allowEndLack = parentReserve.allowEndLack;
        newReserve.tags = parentReserve.tags;
        newReserve.parentDirectoryName = parentReserve.parentDirectoryName;
        newReserve.directory = parentReserve.directory;
        newReserve.recordedFormat = parentReserve.recordedFormat;
        newReserve.encodeMode1 = parentReserve.encodeMode1;
        newReserve.encodeMode2 = parentReserve.encodeMode2;
        newReserve.encodeMode3 = parentReserve.encodeMode3;
        newReserve.encodeParentDirectoryName1 = parentReserve.encodeParentDirectoryName1;
        newReserve.encodeParentDirectoryName2 = parentReserve.encodeParentDirectoryName2;
        newReserve.encodeParentDirectoryName3 = parentReserve.encodeParentDirectoryName3;
        newReserve.encodeDirectory1 = parentReserve.encodeDirectory1;
        newReserve.encodeDirectory2 = parentReserve.encodeDirectory2;
        newReserve.encodeDirectory3 = parentReserve.encodeDirectory3;
        newReserve.isDeleteOriginalAfterEncode = parentReserve.isDeleteOriginalAfterEncode;

        return newReserve;
    }

    /**
     * 引数で指定した予約が追加可能かチェックする。エラーが発生した場合は追加が不可能
     * @param newReserve
     */
    private async checkSingleReserveConflict(newReserve: Reserve): Promise<void> {
        // 追加する予約情報と重複する予約情報を取得 (競合, 除外, 重複しているものは除く)
        let reserves: Reserve[] = [];
        try {
            reserves = await this.reserveDB.findTimeRanges({
                times: [
                    {
                        startAt: newReserve.startAt,
                        endAt: newReserve.endAt,
                    },
                ],
                hasSkip: false,
                hasConflict: false,
                hasOverlap: false,
            });
        } catch (err: any) {
            this.log.system.error('reservation get error');
            throw err;
        }

        reserves.push(newReserve);
        const newReserves = this.createReserves(reserves);

        // 競合したかチェック
        for (const reserve of newReserves) {
            if (reserve.isConflict) {
                this.log.system.error(`program is conflict. programId: ${newReserve.programId}`);
                throw new Error('ReservationManageModelAddReserveConflict');
            }
        }
    }

    /**
     * 手動予約のプションが正しくセットされているかチェックする
     * @param option: ManualReserveOption | EditManualReserveOption
     * @return 正しくセットされていれば true を返す
     */
    private checkManualReserveOption(option: apid.ManualReserveOption, isEdit: boolean = false): boolean {
        let isFail = false;

        // エンコードオプションチェック
        isFail =
            typeof option.encodeOption !== 'undefined' &&
            this.optionChecker.checkEncodeOption(option.encodeOption) === false;

        // 時刻指定予約なのに timeSpecifiedOption が設定されていない
        if (isEdit === false) {
            isFail = typeof option.programId === 'undefined' && typeof option.timeSpecifiedOption === 'undefined';
        }

        return !isFail;
    }

    /**
     * reserve に program の内容をセットする
     * @param reserve: Reserve
     * @param program: Program
     */
    private setProgramToReserve(reserve: Reserve, program: Program | ProgramWithOverlap): void {
        reserve.programId = program.id;
        reserve.programUpdateTime = program.updateTime;
        reserve.channelId = program.channelId;
        reserve.channel = program.channel;
        reserve.channelType = program.channelType;
        reserve.startAt = program.startAt;
        reserve.endAt = program.endAt;
        reserve.name = program.name;
        reserve.shortName = program.shortName;
        reserve.halfWidthName = program.halfWidthName;
        reserve.description = program.description;
        reserve.halfWidthDescription = program.halfWidthDescription;
        reserve.extended = program.extended;
        reserve.halfWidthExtended = program.halfWidthExtended;
        reserve.rawExtended = program.rawExtended;
        reserve.rawHalfWidthExtended = program.rawHalfWidthExtended;
        reserve.genre1 = program.genre1;
        reserve.subGenre1 = program.subGenre1;
        reserve.genre2 = program.genre2;
        reserve.subGenre2 = program.subGenre2;
        reserve.genre3 = program.genre3;
        reserve.subGenre3 = program.subGenre3;
        reserve.videoType = program.videoType;
        reserve.videoResolution = program.videoResolution;
        reserve.videoComponentType = program.videoComponentType;
        reserve.videoStreamContent = program.videoStreamContent;
        reserve.audioSamplingRate = program.audioSamplingRate;
        reserve.audioComponentType = program.audioComponentType;
    }

    /**
     * reserve に saveOption の内容をセットする
     * @param reserve: Reserve
     * @param saveOption: SaveOption
     */
    private setSaveOptionToReserve(reserve: Reserve, saveOption: apid.ReserveSaveOption | undefined): void {
        if (typeof saveOption === 'undefined') {
            reserve.parentDirectoryName = null;
            reserve.directory = null;
            reserve.recordedFormat = null;

            return;
        }

        reserve.parentDirectoryName =
            typeof saveOption.parentDirectoryName === 'undefined' ? null : saveOption.parentDirectoryName;

        reserve.directory = typeof saveOption.directory === 'undefined' ? null : saveOption.directory;

        reserve.recordedFormat = typeof saveOption.recordedFormat === 'undefined' ? null : saveOption.recordedFormat;
    }

    /**
     * reserve に encodeOption の内容をセットする
     * @param reserve: Reserve
     * @param encodeOption: apid.ReserveEncodedOption
     */
    private setEncodeOptionToReserve(reserve: Reserve, encodeOption: apid.ReserveEncodedOption | undefined): void {
        if (typeof encodeOption === 'undefined') {
            reserve.encodeMode1 = null;
            reserve.encodeMode2 = null;
            reserve.encodeMode3 = null;
            reserve.encodeParentDirectoryName1 = null;
            reserve.encodeParentDirectoryName2 = null;
            reserve.encodeParentDirectoryName3 = null;
            reserve.encodeDirectory1 = null;
            reserve.encodeDirectory2 = null;
            reserve.encodeDirectory3 = null;
            reserve.isDeleteOriginalAfterEncode = false;

            return;
        }

        reserve.encodeMode1 = typeof encodeOption.mode1 === 'undefined' ? null : encodeOption.mode1;
        reserve.encodeMode2 = typeof encodeOption.mode2 === 'undefined' ? null : encodeOption.mode2;
        reserve.encodeMode3 = typeof encodeOption.mode3 === 'undefined' ? null : encodeOption.mode3;

        reserve.encodeParentDirectoryName1 =
            typeof encodeOption.encodeParentDirectoryName1 === 'undefined'
                ? null
                : encodeOption.encodeParentDirectoryName1;
        reserve.encodeParentDirectoryName2 =
            typeof encodeOption.encodeParentDirectoryName2 === 'undefined'
                ? null
                : encodeOption.encodeParentDirectoryName2;
        reserve.encodeParentDirectoryName3 =
            typeof encodeOption.encodeParentDirectoryName3 === 'undefined'
                ? null
                : encodeOption.encodeParentDirectoryName3;

        reserve.encodeDirectory1 = typeof encodeOption.directory1 === 'undefined' ? null : encodeOption.directory1;
        reserve.encodeDirectory2 = typeof encodeOption.directory2 === 'undefined' ? null : encodeOption.directory2;
        reserve.encodeDirectory3 = typeof encodeOption.directory3 === 'undefined' ? null : encodeOption.directory3;

        reserve.isDeleteOriginalAfterEncode = encodeOption.isDeleteOriginalAfterEncode;
    }

    /**
     * 手動予約の更新
     */
    public async update(reserveId: apid.ReserveId, isSuppressLog: boolean = false): Promise<void> {
        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(ReservationManageModel.UPDATE_RESERVE_PRIORITY);
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        if (isSuppressLog === false) {
            this.log.system.info(`update reservation: ${reserveId}`);
        }

        // 予約情報を取得する
        const oldReserve = await this.reserveDB.findId(reserveId).catch(err => {
            finalize();
            this.log.system.error(`get reservation error: ${reserveId}`);
            throw err;
        });
        if (oldReserve === null) {
            finalize();
            this.log.system.error(`reservation is not  is not found: ${reserveId}`);
            throw new Error('ReservationIsNotFound');
        }

        // programId 予約か確認する
        if (oldReserve.programId === null) {
            finalize();
            this.log.system.warn(`reservation is not program id reservation: ${reserveId}`);

            return;
        }

        // 番組情報を取得する
        const newProgram = await this.programDB.findId(oldReserve.programId).catch(err => {
            finalize();
            this.log.system.error(`get program error: ${reserveId}`);
            throw err;
        });

        // 番組情報が存在するか確認する
        if (newProgram === null) {
            finalize();
            this.log.system.warn(`program is not found: ${reserveId}`);

            return;
        }

        // 番組情報に更新があったか確認する
        if (oldReserve.programUpdateTime === newProgram.updateTime) {
            finalize();
            if (isSuppressLog === false) {
                this.log.system.info(`no update reservation: ${reserveId}`);
            }

            return;
        }

        // 予約情報生成
        const newReserve = Object.assign({}, oldReserve);
        this.setProgramToReserve(newReserve, newProgram);
        newReserve.updateTime = oldReserve.updateTime;
        newReserve.isConflict = false;
        newReserve.isEventRelay = oldReserve.isEventRelay;

        // 新旧の予約での差分を生成
        const diff = await this.createDiff(
            {
                times: [
                    {
                        startAt: oldReserve.startAt,
                        endAt: oldReserve.endAt,
                    },
                    {
                        startAt: newReserve.startAt,
                        endAt: newReserve.endAt,
                    },
                ],
                hasSkip: false,
                hasConflict: true,
                hasOverlap: false,
                excludeReserveId: reserveId,
            },
            [newReserve],
            [oldReserve],
            isSuppressLog,
        ).catch(err => {
            finalize();
            throw err;
        });

        finalize();

        if (isSuppressLog === false) {
            this.log.system.info(`successful update reservation: ${reserveId}`);
        }

        // イベント発行
        this.reserveEvent.emitUpdated(diff);
    }

    /**
     * ルール変更
     * @param ruleId: rule id
     * @param isSuppressLog ログ出力を抑えるか
     * @param isFirstUpdate: boolean 初回更新か?
     */
    public async updateRule(
        ruleId: apid.RuleId,
        isSuppressLog: boolean = false,
        isFirstUpdate: boolean = false,
    ): Promise<void> {
        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(
            ReservationManageModel.RULE_UPDATE_RESERVE_PRIORITY,
        );
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        if (isSuppressLog === false) {
            this.log.system.info(`update rule reservation: ${ruleId}`);
        }

        // ルールを取得
        const rule = await this.ruleDB.findId(ruleId, true).catch(err => {
            this.log.system.error(`get rule error: ${ruleId}`);
            this.log.system.error(err);
            throw err;
        });

        /**
         * 更新前のルール予約と更新後のルール予約による他の予約の影響を計算する必要があるので、
         * 古いルール予約と新しいルール予約の番組情報を取得し、
         * reserveDB.findTimeRanges で該当する予約を取り出す
         */

        // reserveDB.findTimeRanges で使用するために新旧ルール予約の開始、終了時刻を保存する
        const times: IReserveTimeOption[] = [];

        // 古い予約情報の取り出し
        const oldRuleReserves = await this.reserveDB
            .findRuleId({
                ruleId: ruleId,
                hasSkip: true,
                hasConflict: true,
                hasOverlap: true,
                hasEventRelay: false, // イベントリレーの情報は更新対象とさせないため除外
            })
            .catch(err => {
                finalize();
                this.log.system.error(`find rule reservation error: ${ruleId}`);
                this.log.system.error(err);
                throw err;
            });

        // 新しい予約情報検索
        const newRulePrograms =
            rule !== null && rule.reserveOption.enable === true && rule.isTimeSpecification === false
                ? await this.programDB
                      .findRule({
                          searchOption: rule.searchOption,
                          reserveOption: rule.reserveOption,
                      })
                      .catch(err => {
                          finalize();
                          this.log.system.error(`find rule error: ${ruleId}`);
                          this.log.system.error(err);
                          throw err;
                      })
                : [];

        // 予約情報作成
        const newRuleReserves: Reserve[] = [];
        if (rule !== null && rule.reserveOption.enable === true) {
            // 新しいルール予約情報に skip, overlap の情報をコピーするための索引を作成
            const oldRuleIndex: { [key: string]: Reserve } = {};
            for (const old of oldRuleReserves) {
                oldRuleIndex[this.createReserveKey(old)] = old;
            }

            const updateTime = new Date().getTime();
            if (rule.isTimeSpecification === true) {
                // 時刻指定予約
                if (
                    typeof rule.searchOption.keyword === 'undefined' ||
                    typeof rule.searchOption.channelIds === 'undefined' ||
                    typeof rule.searchOption.times === 'undefined'
                ) {
                    finalize();
                    this.log.system.error(`rule search option error: ${ruleId}`);
                    throw new Error('RuleSearchOptionError');
                }

                // times 準備
                const baseTime = new Date(DateUtil.format(new Date(), 'yyyy/MM/dd 00:00:00 +0900')).getTime();
                for (const time of rule.searchOption.times) {
                    if (typeof time.start === 'undefined' || typeof time.range === 'undefined') {
                        throw new Error('RuleSearchTimesOptionError');
                    }

                    // 曜日情報
                    const weeks: boolean[] = [
                        (time.week & 0x01) !== 0, // 日
                        (time.week & 0x02) !== 0, // 月
                        (time.week & 0x04) !== 0, // 火
                        (time.week & 0x08) !== 0, // 水
                        (time.week & 0x10) !== 0, // 木
                        (time.week & 0x20) !== 0, // 金
                        (time.week & 0x40) !== 0, // 土
                    ];

                    for (let i = 0; i < 8; i++) {
                        // 1 週間分の予約情報を作成する
                        const startAt = baseTime + 1000 * 60 * 60 * 24 * i + time.start * 1000;
                        const endAt = baseTime + 1000 * 60 * 60 * 24 * i + (time.start + time.range) * 1000;

                        if (endAt < updateTime || weeks[new Date(startAt).getDay()] === false) {
                            // 終了時刻が現在時刻より古い or 有効な曜日ではない
                            continue;
                        }

                        // 予約情報検索のために時刻位置取得
                        times.push({
                            startAt: startAt,
                            endAt: endAt,
                        });
                    }
                }

                for (const channelId of rule.searchOption.channelIds) {
                    // channelId
                    let channel: Channel | null;
                    try {
                        channel = await this.channelDB.findId(channelId);
                    } catch (err: any) {
                        this.log.system.error(`get channel id error: ${channelId}`);
                        continue;
                    }
                    if (channel === null) {
                        this.log.system.error(`channel id is not found: ${channelId}`);
                        continue;
                    }

                    // times の分だけ予約情報を生成する
                    for (const time of times) {
                        // 予約情報セット
                        const newReserve = new Reserve();
                        newReserve.isTimeSpecified = true;
                        newReserve.name = StrUtil.toDBStr(rule.searchOption.keyword);
                        newReserve.halfWidthName = StrUtil.toHalf(newReserve.name);
                        newReserve.updateTime = updateTime;
                        newReserve.startAt = time.startAt;
                        newReserve.endAt = time.endAt;
                        newReserve.channelId = channelId;
                        newReserve.channel = channel.channel;
                        newReserve.channelType = channel.channelType;
                        this.setProgramToRuleReserve(newReserve, null, <RuleWithCnt>rule, updateTime);

                        // skip, overlap コピー
                        const oldReserve = oldRuleIndex[this.createReserveKey(newReserve)];
                        if (typeof oldReserve !== 'undefined') {
                            newReserve.isSkip = oldReserve.isSkip;
                            newReserve.isIgnoreOverlap = oldReserve.isIgnoreOverlap;
                            newReserve.isOverlap = oldReserve.isOverlap;
                        }

                        newRuleReserves.push(newReserve);
                    }
                }
            } else if (newRulePrograms.length !== 0) {
                // 新しいルールに一致する予約情報があった
                for (const program of newRulePrograms) {
                    const newReserve = new Reserve();
                    // 予約情報追加
                    this.setProgramToRuleReserve(newReserve, program, <RuleWithCnt>rule, updateTime);

                    // skip, overlap 情報をコピー
                    const oldReserve = oldRuleIndex[this.createReserveKey(newReserve)];
                    if (typeof oldReserve !== 'undefined') {
                        newReserve.isSkip = oldReserve.isSkip;
                        newReserve.isIgnoreOverlap = oldReserve.isIgnoreOverlap;
                        // isIgnoreOverlap が有効な場合はプログラム検索の重複結果ではなく予約の重複結果をコピーする
                        newReserve.isOverlap =
                            oldReserve.isIgnoreOverlap === true ? oldReserve.isOverlap : program.overlap;
                    }
                    newRuleReserves.push(newReserve);

                    // 予約情報検索のために時刻位置取得
                    times.push({
                        startAt: program.startAt,
                        endAt: program.endAt,
                    });
                }
            }
        }

        // 古いルール予約の時刻位置取得
        for (const reserve of oldRuleReserves) {
            times.push({ startAt: reserve.startAt, endAt: reserve.endAt });
        }

        // 初回更新かつ時刻指定予約である場合は
        // createDiff 実行時に差分を出して録画タイマーを生成するように強制する
        if (isFirstUpdate === true && rule?.isTimeSpecification === true) {
            for (const r of oldRuleReserves) {
                r.ruleUpdateCnt = -1; // ruleUpdateCnt は 0 以上しか存在しないので強制的に差分となる
            }
        }

        // 新旧の予約での差分を生成
        const diff = await this.createDiff(
            {
                times: times,
                hasSkip: false,
                hasConflict: true,
                hasOverlap: false,
                excludeRuleId: ruleId, // ruleId 指定で古いルール予約は除外する
            },
            newRuleReserves,
            oldRuleReserves,
            isSuppressLog,
        ).catch(err => {
            finalize();
            throw err;
        });

        finalize();

        if (isSuppressLog === false) {
            this.log.system.info(`successful update rule reservation: ${ruleId}`);
        }

        // イベント発行
        this.reserveEvent.emitUpdated(diff);
    }

    /**
     * reserve に 番組情報とルール情報をセットする
     * @param reserve: Reserve
     * @param program: ProgramWithOverlap | null
     * @param rule: RuleWithCnt
     * @param updateTime: apid.UnixtimeMS
     */
    private setProgramToRuleReserve(
        reserve: Reserve,
        program: ProgramWithOverlap | null,
        rule: RuleWithCnt,
        updateTime: apid.UnixtimeMS,
    ): void {
        reserve.ruleId = rule.id;
        reserve.ruleUpdateCnt = rule.updateCnt;
        reserve.updateTime = updateTime;
        reserve.allowEndLack = rule.reserveOption.allowEndLack;

        if (typeof rule.reserveOption.tags !== 'undefined') {
            reserve.tags = JSON.stringify(rule.reserveOption.tags);
        }

        if (program !== null) {
            reserve.isOverlap = program.overlap;
            this.setProgramToReserve(reserve, program);
        }

        if (typeof rule.saveOption !== 'undefined') {
            this.setSaveOptionToReserve(reserve, rule.saveOption);
        }

        if (typeof rule.encodeOption !== 'undefined') {
            this.setEncodeOptionToReserve(reserve, rule.encodeOption);
        }
    }

    /**
     * 新旧の予約の差分を生成 & DB へ適応する
     * @param findOption :IFindTimeRangesOption
     * @param addNewReserves: 新規追加する予約
     * @param addOldReserves: 旧のみに含まれる予約
     * @param isSuppressLog: ログ出力を抑えるか
     * @return IReserveUpdateValues
     */
    private async createDiff(
        findOption: IFindTimeRangesOption,
        addNewReserves: Reserve[],
        addOldReserves: Reserve[],
        isSuppressLog: boolean,
    ): Promise<IReserveUpdateValues> {
        // 影響を受ける可能性のある予約を取り出す
        const baseReserves = await this.reserveDB.findTimeRanges(findOption).catch(err => {
            this.log.system.error('reserve get error');
            throw err;
        });

        let newReserves = this.copyReserveArray(addNewReserves);
        // baseReserves を破壊しないように copyReserveArray で deep copy する
        Array.prototype.push.apply(newReserves, this.copyReserveArray(baseReserves));

        // 予約情報を計算
        newReserves = this.createReserves(newReserves);

        // 古い予約情報と差分を列挙する
        const oldReserves = this.copyReserveArray(addOldReserves);
        // baseReserves を破壊しないように copyReserveArray で deep copy する
        Array.prototype.push.apply(oldReserves, this.copyReserveArray(baseReserves));

        // oldReserves と newReserves の差分を列挙
        const diff = this.createReservesDiff(oldReserves, newReserves, isSuppressLog);

        if (isSuppressLog === false) {
            this.log.system.info({
                insert: typeof diff.insert === 'undefined' ? 0 : diff.insert.length,
                update: typeof diff.update === 'undefined' ? 0 : diff.update.length,
                delete: typeof diff.delete === 'undefined' ? 0 : diff.delete.length,
            });
        }

        // 列挙した予約情報を DB へ反映させる
        await this.reserveDB.updateMany(diff).catch(err => {
            this.log.system.error('reserves update many error');
            throw err;
        });

        return diff;
    }

    /**
     * Reserve[] をコピーする
     * @param src: Reserve[]
     * @return Reserve[]
     */
    private copyReserveArray(src: Reserve[]): Reserve[] {
        const newReserves: Reserve[] = [];

        for (const reserve of src) {
            newReserves.push(Object.assign({}, reserve));
        }

        return newReserves;
    }

    /**
     * 予約情報の差分作成
     * 手動時刻指定予約の差分はチェックしないので注意
     * @param oldReserves: Reserve[]
     * @param newReserves: Reserve[]
     * @param isSuppressLog: boolean ログ出力を抑えるか
     * @return IReserveUpdateValues
     */
    private createReservesDiff(
        oldReserves: Reserve[],
        newReserves: Reserve[],
        isSuppressLog: boolean,
    ): IReserveUpdateValues {
        const diff: IReserveUpdateValues = {
            isSuppressLog: isSuppressLog,
        };

        diff.insert = [];
        diff.update = [];
        diff.delete = [];

        // 検索用のインデックスを作成
        const idIndex: { [key: string]: ReserveDiffData } = {}; // program id
        const timeIndex: { [key: string]: ReserveDiffData } = {}; // 時刻指定予約
        for (const reserve of oldReserves) {
            if (reserve.programId === null) {
                timeIndex[this.createReserveKey(reserve)] = {
                    reserve: reserve,
                    isChecked: false,
                };
            } else {
                idIndex[this.createReserveKey(reserve)] = {
                    reserve: reserve,
                    isChecked: false,
                };
            }
        }

        // 差分チェック
        for (const newReserve of newReserves) {
            const key = this.createReserveKey(newReserve);
            if (typeof idIndex[key] !== 'undefined') {
                idIndex[key].isChecked = true;
                const oldReserve = idIndex[key].reserve;
                // oldReserve と差分をチェック
                if (this.checkProgramIdReserveDiff(oldReserve, newReserve)) {
                    // update のために reserve id をコピーする
                    newReserve.id = oldReserve.id;
                    diff.update.push(newReserve);
                }
            } else if (typeof timeIndex[key] !== 'undefined') {
                timeIndex[key].isChecked = true;
                const oldReserve = timeIndex[key].reserve;
                // oldReserve と差分をチェック
                if (this.checkTimeRuleReserveDiff(oldReserve, newReserve)) {
                    // update のために reserve id をコピーする
                    newReserve.id = oldReserve.id;
                    diff.update.push(newReserve);
                }
            } else {
                // 新規追加予約情報
                diff.insert.push(newReserve);
            }
        }

        // 削除する予約を追加
        for (const key in idIndex) {
            if (idIndex[key].isChecked === false) {
                diff.delete.push(idIndex[key].reserve);
            }
        }
        for (const key in timeIndex) {
            if (timeIndex[key].isChecked === false) {
                diff.delete.push(timeIndex[key].reserve);
            }
        }

        return diff;
    }

    /**
     * 予約情報から固有の key を作成する
     * @param reserve: Reserve
     * @return string
     */
    private createReserveKey(reserve: Reserve): string {
        return (
            (reserve.programId === null
                ? `${reserve.startAt}-${reserve.endAt}-${reserve.channel}`
                : `${reserve.programId}`) + `-${reserve.ruleId}`
        );
    }

    /**
     * program id のある予約に差分があるかチェック
     * @param oldReserves: Reserve
     * @param newReserve: Reserve
     * @return boolean 差分があれば true
     */
    private checkProgramIdReserveDiff(oldReserve: Reserve, newReserve: Reserve): boolean {
        return (
            oldReserve.programId === newReserve.programId &&
            (oldReserve.programUpdateTime !== newReserve.programUpdateTime ||
                oldReserve.ruleUpdateCnt !== newReserve.ruleUpdateCnt ||
                oldReserve.isSkip !== newReserve.isSkip ||
                oldReserve.isConflict !== newReserve.isConflict ||
                oldReserve.isOverlap !== newReserve.isOverlap)
        );
    }

    /**
     * 時刻ルール予約の差分をチェク
     * 手動時刻指定予約の差分はチェックしないので注意
     * @param oldReserve: Reserve
     * @param newReserve: Reserve
     * @return boolean 差分があれば true
     */
    private checkTimeRuleReserveDiff(oldReserve: Reserve, newReserve: Reserve): boolean {
        return (
            oldReserve.ruleId !== null &&
            newReserve.ruleId !== null &&
            (oldReserve.ruleUpdateCnt !== newReserve.ruleUpdateCnt ||
                oldReserve.isSkip !== newReserve.isSkip ||
                oldReserve.isConflict !== newReserve.isConflict ||
                oldReserve.isOverlap !== newReserve.isOverlap)
        );
    }

    /**
     * 全ての予約情報の更新
     * @param isFirstUpdate: boolean 初回更新か
     */
    public async updateAll(isFirstUpdate: boolean = false): Promise<void> {
        this.log.system.info('all reservation update start');

        const isSuppressLog = this.config.isSuppressReservesUpdateAllLog;

        // 手動予約 (program id) の id を取得
        const manualIds = await this.reserveDB.getManualIds({ hasTimeReserve: false }).catch(err => {
            this.log.system.error('get manual reservation ids error');
            throw err;
        });

        // ルール予約によってイベントリレーで予約された予約の id を取得
        const ruleEventRelayIds = await this.reserveDB.getRuleEventRelayIds().catch(err => {
            this.log.system.error('get rule event relay ids error');
            throw err;
        });

        // ルールの id を取得
        const ruleIds = await this.ruleDB.getIds().catch(err => {
            this.log.system.error('get rule ids error');
            throw err;
        });

        // 手動予約更新
        for (const manualId of manualIds) {
            await this.update(manualId, isSuppressLog).catch(err => {
                this.log.system.error(err);
            });
            await Util.sleep(10);
        }

        // ルール予約によってイベントリレーで予約された予約の更新
        for (const manualId of ruleEventRelayIds) {
            await this.update(manualId, isSuppressLog).catch(err => {
                this.log.system.error(err);
            });
            await Util.sleep(10);
        }

        // ルール予約更新
        for (const ruleId of ruleIds) {
            await this.updateRule(ruleId, isSuppressLog, isFirstUpdate).catch(err => {
                this.log.system.error(err);
            });
            await Util.sleep(10);
        }

        this.log.system.info('all reservation update finish');
    }

    /**
     * 予約キャンセル
     * 手動予約の場合は削除
     * ルール予約の場合は除外
     * @param reserveId 予約 ID
     */
    public async cancel(reserveId: apid.ReserveId): Promise<void> {
        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(ReservationManageModel.CANCEL_RESERVE_PRIORITY);
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        this.log.system.info(`cancel reservation: ${reserveId}`);

        // reserveId が存在するかチェック
        const cancelReserve = await this.reserveDB.findId(reserveId).catch(err => {
            finalize();
            this.log.system.error(`get reservation error: ${reserveId}`);
            throw err;
        });

        if (cancelReserve === null) {
            finalize();
            this.log.system.error(`reservation is not found: ${reserveId}`);
            throw new Error('ReservationIsNotFound');
        }

        const oldReserves: Reserve[] = [Object.assign({}, cancelReserve)];

        // 比較のために新しい予約情報を生成
        const newReserves: Reserve[] = [];
        if (cancelReserve.ruleId !== null && cancelReserve.isEventRelay === false) {
            // ルール予約の場合
            if (cancelReserve.isOverlap === true) {
                // overlap
                cancelReserve.isIgnoreOverlap = false;
                cancelReserve.isOverlap = true;
            } else {
                // skip
                cancelReserve.isSkip = true;
            }
            // skip or overlap している場合は競合しない
            cancelReserve.isConflict = false;

            // 新しい予約情報に追加
            newReserves.push(cancelReserve);
        }

        // 新旧の予約での差分を生成
        const diff = await this.createDiff(
            {
                times: [
                    {
                        startAt: cancelReserve.startAt,
                        endAt: cancelReserve.endAt,
                    },
                ],
                hasSkip: false,
                hasConflict: true,
                hasOverlap: false,
                excludeReserveId: reserveId,
            },
            newReserves,
            oldReserves,
            false,
        ).catch(err => {
            finalize();
            throw err;
        });

        finalize();

        this.log.system.info(`successful cancel reservation: ${reserveId}`);

        // イベント発行
        this.reserveEvent.emitUpdated(diff);
    }

    /**
     * skip の解除
     * @param reserveId: reserve id
     */
    public async removeSkip(reserveId: apid.ReserveId): Promise<void> {
        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(
            ReservationManageModel.REMOVE_SKIP_RESERVE_PRIORITY,
        );
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        this.log.system.info(`remove skip reservation: ${reserveId}`);

        // reserveId が存在するかチェック
        const oldReserve = await this.reserveDB.findId(reserveId).catch(err => {
            finalize();
            this.log.system.error(`get reservation error: ${reserveId}`);
            throw err;
        });
        if (oldReserve === null) {
            finalize();
            this.log.system.error(`reservation is not found: ${reserveId}`);
            throw new Error('ReservationIsNotFound');
        }

        // ルール予約かチェック
        if (oldReserve.ruleId === null || oldReserve.isEventRelay === true) {
            finalize();
            this.log.system.warn(`reservation is not rule reservation: ${reserveId}`);

            return;
        }

        // skip が有効化チェック
        if (oldReserve.isSkip !== true) {
            finalize();
            this.log.system.warn(`reservation is not skiped: ${reserveId}`);

            return;
        }

        // skip を解除した予約を作成
        const newReserves: Reserve = Object.assign({}, oldReserve);
        newReserves.isSkip = false;

        const diff = await this.createDiff(
            {
                times: [
                    {
                        startAt: oldReserve.startAt,
                        endAt: oldReserve.endAt,
                    },
                ],
                hasSkip: false,
                hasConflict: true,
                hasOverlap: false,
                excludeReserveId: reserveId,
            },
            [newReserves],
            [oldReserve],
            false,
        ).catch(err => {
            finalize();
            throw err;
        });

        finalize();

        this.log.system.info(`successful remove skip reservation: ${reserveId}`);

        // イベント発行
        this.reserveEvent.emitUpdated(diff);
    }

    /**
     * overlap の解除
     * @param reserveId: reserve id
     * @return Promise<void>
     */
    public async removeOverlap(reserveId: apid.ReserveId): Promise<void> {
        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(
            ReservationManageModel.REMOVE_OVERLAP_RESERVE_PRIORITY,
        );
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        this.log.system.info(`remove overlap reservation: ${reserveId}`);

        // reserveId が存在するかチェック
        const oldReserve = await this.reserveDB.findId(reserveId).catch(err => {
            finalize();
            this.log.system.error(`get reservation error: ${reserveId}`);
            throw err;
        });
        if (oldReserve === null) {
            finalize();
            this.log.system.error(`reservation is not found: ${reserveId}`);
            throw new Error('ReservationIsNotFound');
        }

        // ルール予約かチェック
        if (oldReserve.ruleId === null || oldReserve.isEventRelay === true) {
            finalize();
            this.log.system.warn(`reservation is not rule reservation: ${reserveId}`);

            return;
        }

        // overlap が解除されていないかチェック
        if (oldReserve.isIgnoreOverlap === true && oldReserve.isOverlap === false) {
            finalize();
            this.log.system.warn(`reservation is removed overlap: ${reserveId}`);

            return;
        }

        // overlap を解除した予約を作成
        const newReserves: Reserve = Object.assign({}, oldReserve);
        newReserves.isIgnoreOverlap = true;
        newReserves.isOverlap = false;

        const diff = await this.createDiff(
            {
                times: [
                    {
                        startAt: oldReserve.startAt,
                        endAt: oldReserve.endAt,
                    },
                ],
                hasSkip: false,
                hasConflict: true,
                hasOverlap: false,
                excludeReserveId: reserveId,
            },
            [newReserves],
            [oldReserve],
            false,
        ).catch(err => {
            finalize();
            throw err;
        });

        finalize();

        this.log.system.info(`successful remove overlap reservation: ${reserveId}`);

        // イベント発行
        this.reserveEvent.emitUpdated(diff);
    }

    /**
     * 手動予約の編集
     * allowEndLack, saveOption, encodeOption を更新する
     * @param reserveId: reserve id
     * @param option: apid.EditManualReserveOption
     */
    public async edit(reserveId: apid.ReserveId, option: apid.EditManualReserveOption): Promise<void> {
        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(ReservationManageModel.EDIT_RESERVE_PRIORITY);
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        this.log.system.info(`edit reservation: ${reserveId}`);

        // オプションチェック
        if (this.checkManualReserveOption(option, true) === false) {
            this.log.system.error('edit reservation option error');
            throw new Error('ReservationEditError');
        }

        // reserveId が存在するかチェック
        const newReserve = await this.reserveDB.findId(reserveId).catch(err => {
            finalize();
            this.log.system.error(`get reservation error: ${reserveId}`);
            throw err;
        });
        if (newReserve === null) {
            finalize();
            this.log.system.error(`reservation is not found: ${reserveId}`);
            throw new Error('ReservationIsNotFound');
        }

        // option から必要な情報をセットする
        newReserve.allowEndLack = option.allowEndLack;
        if (typeof option.tags !== 'undefined') {
            newReserve.tags = JSON.stringify(option.tags);
        }
        this.setSaveOptionToReserve(newReserve, option.saveOption);
        this.setEncodeOptionToReserve(newReserve, option.encodeOption);

        // 更新
        await this.reserveDB.updateOnce(newReserve).catch(err => {
            finalize();
            this.log.system.error(`update reservation error: ${reserveId}`);
            throw err;
        });

        // 完了したのでロック解除
        finalize();

        this.log.system.info(`successful edit reservation: ${reserveId}`);

        // イベント発行
        this.reserveEvent.emitUpdated({
            update: [newReserve],
            isSuppressLog: false,
        });
    }

    /**
     * 現在時刻より古い予約を削除する
     */
    public async cleanup(): Promise<void> {
        // 実行権取得
        const exeId = await this.executeManagementModel.getExecution(ReservationManageModel.EDIT_RESERVE_PRIORITY);
        const finalize = () => {
            this.executeManagementModel.unLockExecution(exeId);
        };

        this.log.system.info('start reserves cleanup');

        // 古い予約を取得する
        const deleteReserves = await this.reserveDB.findOldTime(new Date().getTime()).catch(err => {
            finalize();
            this.log.system.error('get delete old reservation error');
            throw err;
        });

        // 削除
        await this.reserveDB
            .updateMany({
                delete: deleteReserves,
                isSuppressLog: false,
            })
            .catch(err => {
                finalize();
                this.log.system.error('delete old reservation error');
                throw err;
            });

        // 完了したのでロック解除
        finalize();

        this.log.system.info('finish reserves cleanup');

        // イベント発行
        this.reserveEvent.emitUpdated({
            delete: deleteReserves,
            isSuppressLog: false,
        });
    }

    /**
     * 予約情報を生成する
     * 平面走査法のような事をしている
     * @param matches 予約したい番組情報
     * @return Reserve[] 予約情報
     */
    private createReserves(matches: Reserve[]): Reserve[] {
        // 重複チェックのために programId でソート
        matches.sort(this.sortReserve);

        const list: {
            time: apid.UnixtimeMS;
            isStart: boolean;
            idx: number; // matches index
        }[] = [];

        // 重複チェック用 index
        const programIdIndex: { [key: string]: boolean } = {};

        // list を生成
        for (let i = 0; i < matches.length; i++) {
            // programId 予約における重複を検知するためのキーを生成する
            const matchProgramIdKey = this.getRuleProgramIdKey(matches[i]);

            if (matchProgramIdKey !== null) {
                // programId がすでに存在する場合は list に追加しない
                if (typeof programIdIndex[matchProgramIdKey] === 'undefined') {
                    programIdIndex[matchProgramIdKey] = true;
                } else {
                    continue;
                }
            }

            list.push({
                time: matches[i].startAt,
                isStart: true,
                idx: i,
            });
            list.push({
                time: matches[i].endAt,
                isStart: false,
                idx: i,
            });
        }

        // list を ソート
        list.sort((a, b) => {
            const time = a.time - b.time;

            if (time !== 0) {
                return time;
            } else if (a.isStart && !b.isStart) {
                return 1;
            } else if (!a.isStart && b.isStart) {
                return -1;
            } else {
                return a.idx - b.idx;
            }
        });

        // 予約情報が格納可能かチェックする
        const conflictResults: { [key: number]: boolean } = {}; // 重複の評価結果の格納先
        const reserves: { reserve: Reserve; idx: number }[] = []; // 時間帯が重複する番組情報の格納先
        for (const l of list) {
            if (matches[l.idx].isSkip) {
                continue;
            }

            if (l.isStart) {
                // add
                reserves.push({ reserve: matches[l.idx], idx: l.idx });
            } else {
                // remove
                const index = reserves.findIndex(r => {
                    return r.idx === l.idx;
                });
                reserves.splice(index, 1);
            }

            // sort reserves
            reserves.sort((a, b) => {
                return this.sortReserve(a.reserve, b.reserve);
            });

            this.log.system.debug('--------------------');
            for (const r of reserves) {
                this.log.system.debug(<any>{
                    name: r.reserve.name,
                    ruleId: r.reserve.ruleId,
                });
            }

            // tuner clear
            for (let i = 0; i < this.tuners.length; i++) {
                this.tuners[i].clear();
            }

            // 重複の評価
            for (const reserve of reserves) {
                if (matches[reserve.idx].isSkip || matches[reserve.idx].isOverlap) {
                    continue;
                }

                let isConflict = true;
                for (let i = 0; i < this.tuners.length; i++) {
                    if (this.tuners[i].add(matches[reserve.idx])) {
                        isConflict = false;
                        break;
                    }
                }

                // 重複したか？
                if (isConflict) {
                    conflictResults[reserve.idx] = true;
                }
            }
        }

        // list から重複を除外した予約情報を生成
        const newReserves: Reserve[] = [];
        for (const l of list) {
            if (l.isStart) {
                // matches の破損防止のために予約情報のコピーする
                const newReserve: Reserve = Object.assign({}, matches[l.idx]);
                // 重複の評価結果の反映
                newReserve.isConflict = conflictResults[l.idx] === true;
                // 予約情報 の格納
                newReserves.push(newReserve);
            }
        }

        return newReserves.sort((a, b) => {
            return a.startAt - b.startAt;
        });
    }

    /**
     * Reserve のソート用関数
     * 時刻指定予約 > 手動予約 > ルール予約
     * manualId が小さい > manualId が大きい > ruleId が小さい > ruleId が大きい の順で判定する
     * @param a: Reserve
     * @param b: Reserve
     * @return number
     */
    private sortReserve(a: Reserve, b: Reserve): number {
        const aIsManual = a.ruleId === null;
        const bIsManual = b.ruleId === null;

        if (aIsManual && bIsManual) {
            if (a.isTimeSpecified === b.isTimeSpecified) {
                return a.updateTime - b.updateTime;
            } else {
                return a.isTimeSpecified && !b.isTimeSpecified ? -1 : 1;
            }
        }
        if (aIsManual && !bIsManual) {
            return -1; // // 手動予約を優先
        }
        if (!aIsManual && bIsManual) {
            return 1; // // 手動予約を優先
        }
        if (!aIsManual && !bIsManual && a.ruleId !== null && b.ruleId !== null) {
            return a.ruleId - b.ruleId;
        }

        return 0;
    }

    /**
     * 予約の ProgramId の重複検知するための key を生成する
     * @param re: reserve
     * @returns string | null programId 予約でない場合は null を返す
     */
    private getRuleProgramIdKey(re: Reserve): string | null {
        // programId 予約ではない
        if (re.programId === null) {
            return null;
        }

        // 非ルール予約であれば ProgramId を返し、そうでなければ ProgramId に競合、重複、スキップ情報を追加して返す
        return re.ruleId === null
            ? re.programId.toString(10)
            : `${re.programId.toString(10)}-${re.isConflict}-${re.isOverlap}-${re.isSkip}`;
    }
}

namespace ReservationManageModel {
    export const ADD_RESERVE_PRIORITY = 1;
    export const UPDATE_RESERVE_PRIORITY = 1;
    export const RULE_UPDATE_RESERVE_PRIORITY = 1;
    export const CANCEL_RESERVE_PRIORITY = 2;
    export const REMOVE_SKIP_RESERVE_PRIORITY = 2;
    export const REMOVE_OVERLAP_RESERVE_PRIORITY = 2;
    export const EDIT_RESERVE_PRIORITY = 2;
}

export default ReservationManageModel;
