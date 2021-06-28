import Ajv from "ajv";
import addFormats from "ajv-formats";
import { providers, Signer } from "ethers";
import { Evt } from "evt";
import {
  getRandomBytes32,
  TIntegerString,
  TAddress,
  NxtpMessaging,
  NatsNxtpMessagingService,
} from "@connext/nxtp-utils";
import { BaseLogger } from "pino";
import { Type, Static } from "@sinclair/typebox";
import { handleReceiverPrepare, prepare } from "./crossChainTransfer";
import { PrepareParams } from "./types";
import {
  TransactionCancelledEvent,
  TransactionFulfilledEvent,
  TransactionManagerEvent,
  TransactionManagerEventPayloads,
  TransactionManagerEvents,
  TransactionManagerListener,
  TransactionPreparedEvent,
} from "./utils";

export const CrossChainParamsSchema = Type.Object({
  callData: Type.Optional(Type.RegEx(/^0x[a-fA-F0-9]*$/)),
  router: TAddress,
  sendingAssetId: TAddress,
  receivingAssetId: TAddress,
  receivingAddress: TAddress,
  amount: TIntegerString,
  expiry: TIntegerString,
  transactionId: Type.Optional(Type.RegEx(/^0x[a-fA-F0-9]{64}$/)),
});

export type CrossChainParams = Static<typeof CrossChainParamsSchema>;

// TODO: do we want to make these more specific?
// i.e. SenderTransactionPrepared, ReceiverTransactionPrepared,
// etc.
export const NxtpSdkEvents = {
  ...TransactionManagerEvents,
  TransactionCompleted: "TransactionCompleted",
} as const;
export type NxtpSdkEvent = typeof NxtpSdkEvents[keyof typeof NxtpSdkEvents];

// TODO: is this the event payload we want? anything else?
export type TransactionCompletedEvent = TransactionFulfilledEvent;

export interface NxtpSdkEventPayloads extends TransactionManagerEventPayloads {
  [NxtpSdkEvents.TransactionCompleted]: TransactionCompletedEvent;
}

// TODO: stronger types
export interface NxtpSdk {
  transfer(
    params: CrossChainParams,
  ): Promise<{ prepareReceipt: providers.TransactionReceipt; completed: TransactionCompletedEvent }>;
  // getTransferQuote(): Promise<any>;
  // getTransferHistory(): Promise<any>;
}

const ajv = addFormats(new Ajv(), [
  "date-time",
  "time",
  "date",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
])
  .addKeyword("kind")
  .addKeyword("modifier");

export class NxtpSdk {
  private evts: { [K in NxtpSdkEvent]: Evt<NxtpSdkEventPayloads[K]> } = {
    [NxtpSdkEvents.TransactionPrepared]: Evt.create<TransactionPreparedEvent>(),
    [NxtpSdkEvents.TransactionFulfilled]: Evt.create<TransactionFulfilledEvent>(),
    [NxtpSdkEvents.TransactionCancelled]: Evt.create<TransactionCancelledEvent>(),
    [NxtpSdkEvents.TransactionCompleted]: Evt.create<TransactionCompletedEvent>(),
  };

  private constructor(
    private readonly sendingProvider: providers.JsonRpcProvider,
    private readonly receivingProvider: providers.JsonRpcProvider,
    private readonly sendingListener: TransactionManagerListener,
    private readonly receivingListener: TransactionManagerListener,
    private readonly signer: Signer,
    private readonly messaging: NxtpMessaging,
    private readonly logger: BaseLogger,
  ) {}

  // TODO: handle messaging service
  static async init(
    sendingProvider: providers.JsonRpcProvider,
    receivingProvider: providers.JsonRpcProvider,
    signer: Signer,
    messagingUrl: string,
    logger: BaseLogger,
  ): Promise<NxtpSdk> {
    // Create messaging
    const addr = await signer.getAddress();
    const messaging = new NatsNxtpMessagingService({
      signer,
      messagingUrl,
      logger: logger.child({ module: "NxtpMessaging", name: addr }),
    });
    await messaging.connect();

    // Start up transaction manager listeners
    const sendingListener = await TransactionManagerListener.connect(sendingProvider);
    const receivingListener = await TransactionManagerListener.connect(receivingProvider);

    const client = new NxtpSdk(
      sendingProvider,
      receivingProvider,
      sendingListener,
      receivingListener,
      signer,
      messaging,
      logger.child({ module: "NxtpSdk", name: addr }),
    );

    client.setupListeners();

    // TODO: check chain for any existing transactions that should be fulfilled
    // or cancelled
    return client;
  }

  public async transfer(
    transferParams: CrossChainParams,
  ): Promise<{ prepareReceipt: providers.TransactionReceipt; completed: TransactionCompletedEvent }> {
    const method = "transfer";
    const methodId = getRandomBytes32();
    this.logger.info({ method, methodId, transferParams }, "Method started");

    // Validate params schema
    const validate = ajv.compile(CrossChainParamsSchema);
    const valid = validate(transferParams);
    if (!valid) {
      const error = validate.errors?.map(err => err.message).join(",");
      this.logger.error({ error, transferParams }, "Invalid transfer params");
      throw new Error(`Invalid params - ${error}`);
    }

    // Create promise for completed tx
    const transactionId = transferParams.transactionId ?? getRandomBytes32();
    const timeout = 300_000;
    const completed = this.evts.TransactionCompleted.pipe(data => data.txData.transactionId === transactionId).waitFor(
      timeout,
    );

    const { sendingAssetId, receivingAssetId, receivingAddress, router, amount, expiry, callData } = transferParams;

    // Prepare sender side tx
    const { chainId: sendingChainId } = await this.sendingProvider.getNetwork();
    const { chainId: receivingChainId } = await this.receivingProvider.getNetwork();
    const params: PrepareParams = {
      signer: this.signer,
      sendingProvider: this.sendingProvider,
      sendingChainId,
      receivingChainId,
      sendingAssetId,
      receivingAssetId,
      receivingAddress,
      router,
      amount,
      expiry,
      callData,
      transactionId,
    };
    const prepareReceipt = await prepare(params, this.sendingListener.getTransactionManager(), this.logger);

    // wait for completed event
    const event = await completed;
    return { prepareReceipt, completed: event };
  }

  private setupListeners(): void {
    // Always broadcast signature when a receiver-side prepare event is emitted
    this.receivingListener.attach(TransactionManagerEvents.TransactionPrepared, async data => {
      // Always automatically broadcast signatures for recieving chain
      // TODO: how to handle relayer fees here? will need before signing
      this.logger.info({ ...data }, "Handling receiver tx prepared event");
      await handleReceiverPrepare(
        {
          txData: data.txData,
          signer: this.signer,
          receivingProvider: this.receivingProvider,
          relayerFee: "0",
        },
        this.receivingListener.getTransactionManager(),
        this.messaging,
        this.logger,
      );
    });

    // Emit transaction completed event when receiver-side fulfill event is
    // emitted
    // TODO: what if this is an asynchronous event? i.e. happens when a tx is
    // fulfilled as you're switching between chains in the UI? (ie going from
    // matic to bsc then bsc to matic and router fulfills)
    this.receivingListener.attach(TransactionManagerEvents.TransactionFulfilled, async data => {
      this.evts[NxtpSdkEvents.TransactionCompleted].post(data);
    });

    // Parrot all sending and receiving chain events
    Object.keys(this.evts).forEach((_event: string) => {
      if (_event === NxtpSdkEvents.TransactionCompleted) {
        return;
      }
      const event = _event as TransactionManagerEvent;
      this.sendingListener.attach(event as TransactionManagerEvent, data => {
        this.evts[event].post(data as any);
      });
      this.receivingListener.attach(event as TransactionManagerEvent, data => {
        this.evts[event].post(data as any);
      });
    });
  }

  // Listener methods
  public attach<T extends NxtpSdkEvent>(
    event: T,
    callback: (data: NxtpSdkEventPayloads[T]) => void,
    filter: (data: NxtpSdkEventPayloads[T]) => boolean = (_data: NxtpSdkEventPayloads[T]) => true,
    timeout?: number,
  ): void {
    const args = [timeout, callback].filter(x => !!x);
    this.evts[event].pipe(filter).attach(...(args as [number, any]));
  }

  public attachOnce<T extends NxtpSdkEvent>(
    event: T,
    callback: (data: NxtpSdkEventPayloads[T]) => void,
    filter: (data: NxtpSdkEventPayloads[T]) => boolean = (_data: NxtpSdkEventPayloads[T]) => true,
    timeout?: number,
  ): void {
    const args = [timeout, callback].filter(x => !!x);
    this.evts[event].pipe(filter).attachOnce(...(args as [number, any]));
  }

  public detach<T extends NxtpSdkEvent>(event?: T): void {
    if (event) {
      this.evts[event].detach();
      return;
    }
    Object.values(this.evts).forEach(evt => evt.detach());
  }

  public waitFor<T extends NxtpSdkEvent>(
    event: T,
    timeout: number,
    filter: (data: NxtpSdkEventPayloads[T]) => boolean = (_data: NxtpSdkEventPayloads[T]) => true,
  ): Promise<NxtpSdkEventPayloads[T]> {
    return this.evts[event].pipe(filter).waitFor(timeout) as any;
  }
}
