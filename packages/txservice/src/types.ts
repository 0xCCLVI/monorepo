import { BigNumber, BigNumberish, utils } from "ethers";

import { TransactionServiceFailure } from "./error";

export type ReadTransaction = {
  chainId: number;
  to: string;
  data: string;
};

export type WriteTransaction = {
  from?: string;
  value: BigNumberish;
} & ReadTransaction;

export type FullTransaction = {
  nonce: number;
  gasPrice: BigNumber;
  gasLimit: BigNumber;
} & WriteTransaction;

// TODO: Cache all the provider call responses, and have one singular data structure for managing that cache.
export type CachedGas = {
  price: BigNumber;
  timestamp: number;
};

export type CachedTransactionCount = {
  value: number;
  timestamp: number;
}

/**
 * @classdesc Handles getting gas prices and enforcing maximums for transactions
 */
export class Gas {
  private _gasPrice: BigNumber;
  private readonly _maxGasPrice: BigNumber;

  /**
   * Gets the current gas price
   * @returns BigNumber representation of gas price
   */
  public get price(): BigNumber {
    return BigNumber.from(this._gasPrice);
  }

  /**
   * Validates + sets the current gas price
   *
   * @param value - Gas price to set
   */
  public set price(value: BigNumber) {
    this.validate(value);
    this._gasPrice = value;
  }

  constructor(public readonly baseValue: BigNumber, public readonly limit: BigNumber) {
    this._gasPrice = baseValue;
    // Enforce a max gas price 250% higher than the base value as a buffer.
    // This means, using the default config (at the time of writing this) we'll be able to execute about
    // 10 gas bumps before hitting the ceiling.
    // TODO: Use the config to set this value.
    const absoluteMax = utils.parseUnits("2000", "gwei");
    const max = baseValue.mul(5).div(2);
    this._maxGasPrice = max.gt(absoluteMax) ? absoluteMax : max;
  }

  public setToMax() {
    this._gasPrice = this._maxGasPrice.sub(10);
  }

  /**
   * Check to see if the gas price provided is past the max. If so, throw.
   *
   * @param value Gas price to validate.
   *
   * @throws TransactionServiceFailure with reason MaxGasPriceReached if we exceed the limit.
   */
  private validate(value: BigNumber) {
    if (value.gt(this._maxGasPrice)) {
      throw new TransactionServiceFailure(TransactionServiceFailure.reasons.MaxGasPriceReached, {
        gasPrice: `${utils.formatUnits(value, "gwei")} gwei`,
        gasLimit: `${utils.formatUnits(this.limit, "gwei")} gwei`,
        max: `${utils.formatUnits(this._maxGasPrice, "gwei")} gwei`,
      });
    }
  }
}
