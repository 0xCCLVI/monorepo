import { NxtpMessaging } from "@connext/nxtp-utils";
import { BaseLogger } from "pino";

import { Handler } from "./handler";
import {
  ReceiverFulfillData,
  ReceiverPrepareData,
  SenderFulfillData,
  SenderPrepareData,
  TransactionManagerListener,
} from "./transactionManagerListener";

/*
    Listener.ts

    The goal of this file is *only* to set up and manage listeners. All handling
    logic should be routed to handlers.ts. 
*/
export async function setupListeners(
  messagingService: NxtpMessaging,
  txManager: TransactionManagerListener,
  handler: Handler,
  logger: BaseLogger,
): Promise<void> {
  // Setup Messaging Service events
  // <from>.auction.<fromChain>.<fromAsset>.<toChain>.<toAsset>
  messagingService.subscribe("*.auction.>", async data => {
    // On every new auction broadcast, route to the new auction handler
    const res = await handler.handleNewAuction(data);
  });

  // <from>.metatx
  messagingService.subscribe("*.metatx", async data => {
    // On every metatx request (i.e. user wants router to fulfill for them)
    // route to metatx handler
    const res = await handler.handleMetaTxRequest(data);
  });

  // Setup Subgraph events
  txManager.onSenderPrepare(async (data: SenderPrepareData) => {
    // On sender prepare, route to sender prepare handler
    const res = await handler.handleSenderPrepare(data);
  });

  txManager.onReceiverPrepare(async (data: ReceiverPrepareData) => {
    // On receiver prepare, route to receiver prepare handler
    const res = await handler.handleReceiverPrepare(data);
  });

  txManager.onSenderFulfill(async (data: SenderFulfillData) => {
    // On sender fulfill, route to sender fulfill handler
    const res = await handler.handleSenderFulfill(data);
  });

  txManager.onReceiverFulfill(async (data: ReceiverFulfillData) => {
    // On receiver fulfill, route to receiver fulfill handler
    const res = await handler.handleReceiverFulfill(data);
  });
}
