// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.1;


struct VariableTransactionData {
  address user;
  uint256 amount;
  uint256 expiry;
  uint256 blockNumber;
  bytes32 digest;
}

interface ITransactionManager {
  // Structs
  struct TransactionData {
    address user;
    address router;
    address sendingAssetId;
    address receivingAssetId;
    address receivingAddress; // if calling fails, or isnt used, this is the address the funds are sent to
    bytes callData;
    bytes32 transactionId;
    uint24 sendingChainId;
    uint24 receivingChainId;
    uint256 amount;
    uint256 expiry;
    uint256 blockNumber;
  }

  struct InvariantTransactionData {
    address user;
    address router;
    address sendingAssetId;
    address receivingAssetId;
    address receivingAddress;
    uint24 sendingChainId;
    uint24 receivingChainId;
    bytes callData;
    bytes32 transactionId;
  }

  struct SignedCancelData {
    bytes32 txDigest;
    string cancel;
  }

  struct SignedFulfillData {
    bytes32 txDigest;
    uint256 relayerFee;
  }

  // Liquidity events
  event LiquidityAdded(
    address router,
    address assetId,
    uint256 amount
  );

  event LiquidityRemoved(
    address router,
    address assetId,
    uint256 amount,
    address recipient
  );

  // Transaction events
  // TODO: structure
  event TransactionPrepared(
    TransactionData txData,
    address caller
  );

  event TransactionFulfilled(
    TransactionData txData,
    uint256 relayerFee,
    bytes signature,
    address caller
  );

  event TransactionCancelled(
    TransactionData txData,
    address caller
  );

  // Getters
  function getActiveTransactionsByUser(address user) external view returns (VariableTransactionData[] memory);

  // Router only methods
  function addLiquidity(uint256 amount, address assetId) external payable;

  function removeLiquidity(uint256 amount, address assetId, address payable recipient) external;

  // Transaction methods
  function prepare(TransactionData calldata txData) external payable returns (TransactionData memory);

  function fulfill(TransactionData calldata txData, uint256 relayerFee, bytes calldata signature) external returns (TransactionData memory);

  function cancel(TransactionData calldata txData, bytes calldata signature) external returns (TransactionData memory);
}