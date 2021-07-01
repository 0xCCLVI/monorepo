/* eslint-disable prefer-const */
import { BigInt } from "@graphprotocol/graph-ts";

import {
  TransactionManager,
  LiquidityAdded,
  LiquidityRemoved,
  TransactionCancelled,
  TransactionFulfilled,
  TransactionPrepared,
} from "../generated/TransactionManager/TransactionManager";
import { Transaction, AssetBalance, Router, User } from "../generated/schema";

export function handleLiquidityAdded(event: LiquidityAdded): void {
  let router = Router.load(event.params.router.toHex());
  if (router == null) {
    router = new Router(event.params.router.toHex());
    router.save();
  }

  // ID is of the format ROUTER_ADDRESS-ASSET_ID
  let assetBalanceId = event.params.assetId.toHex() + "-" + event.params.router.toHex();
  let assetBalance = AssetBalance.load(assetBalanceId);
  if (assetBalance == null) {
    assetBalance = new AssetBalance(assetBalanceId);
    assetBalance.router = router.id;
    assetBalance.amount = new BigInt(0);
  }
  // add new amount
  assetBalance.amount = assetBalance!.amount.plus(event.params.amount);
  assetBalance.save();
}

export function handleLiquidityRemoved(event: LiquidityRemoved): void {
  let router = Router.load(event.params.router.toHex());
  if (router == null) {
    router = new Router(event.params.router.toHex());
    router.save();
  }

  // ID is of the format ROUTER_ADDRESS-ASSET_ID
  let assetBalanceId = event.params.assetId.toHex() + "-" + event.params.router.toHex();
  let assetBalance = AssetBalance.load(assetBalanceId);
  // add new amount
  assetBalance!.amount = assetBalance!.amount.minus(event.params.amount);
  assetBalance!.save();
}

export function handleTransactionPrepared(event: TransactionPrepared): void {
  // load user and router
  // router must necessarily exist at this point because it had to have provided liquidity
  let router = Router.load(event.params.txData.router.toHex());
  if (router == null) {
    router = new Router(event.params.txData.router.toHex());
    router.save();
  }

  let user = User.load(event.params.txData.router.toHex());
  if (user == null) {
    user = new User(event.params.txData.user.toHex());
    user.save();
  }

  // instantiate contract to get the chainId
  let contract = TransactionManager.bind(event.address);
  let chainId = contract.chainId();

  // contract checks ensure that this cannot exist at this point, so we can safely create new
  let transaction = new Transaction(event.params.txData.transactionId.toHex());
  transaction.user = user.id;
  transaction.router = router!.id;
  transaction.amount = event.params.txData.amount;
  transaction.sendingAssetId = event.params.txData.sendingAssetId;
  transaction.receivingAssetId = event.params.txData.receivingAssetId;
  transaction.sendingChainId = event.params.txData.sendingChainId;
  transaction.receivingChainId = event.params.txData.receivingChainId;
  transaction.receivingAddress = event.params.txData.receivingAddress;
  transaction.callData = event.params.txData.callData.toHexString();
  transaction.transactionId = event.params.txData.transactionId;
  transaction.expiry = event.params.txData.expiry;
  transaction.blockNumber = event.params.txData.blockNumber;
  transaction.encodedBid = event.params.encodedBid;
  transaction.bidSignature = event.params.bidSignature;
  transaction.status = "Prepared";
  transaction.chainId = chainId;
  transaction.prepareCaller = event.params.caller;

  transaction.save();
}

export function handleTransactionFulfilled(event: TransactionFulfilled): void {
  // contract checks ensure that this cannot exist at this point, so we can safely create new
  let transaction = Transaction.load(event.params.txData.transactionId.toHex());
  transaction!.status = "Fulfilled";
  transaction!.fulfillCaller = event.params.caller;
  transaction!.relayerFee = event.params.relayerFee;
  transaction!.signature = event.params.signature;

  transaction!.save();
}

export function handleTransactionCancelled(event: TransactionCancelled): void {
  // contract checks ensure that this cannot exist at this point, so we can safely create new
  let transaction = Transaction.load(event.params.txData.transactionId.toHex());
  transaction!.status = "Cancelled";
  transaction!.cancelCaller = event.params.caller;

  transaction!.save();
}
