import {
  AgentKit,
  CdpWalletProvider,
  wethActionProvider,
  walletActionProvider,
  erc20ActionProvider,
  cdpApiActionProvider,
  cdpWalletActionProvider,
  pythActionProvider,
  erc721ActionProvider,
} from "@coinbase/agentkit";

import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatGroq } from "@langchain/groq";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as readline from "readline";
dotenv.config();

// Environment Validation
function validateEnvironment() {
  const missingVars = [];
  const requiredVars = [
    "GROQ_API_KEY",
    "CDP_API_KEY_NAME",
    "CDP_API_KEY_PRIVATE_KEY",
  ];
  requiredVars.forEach((varName) => {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  });

  if (missingVars.length > 0) {
    console.error("Error: Required environment variables are not set");
    missingVars.forEach((varName) => {
      console.error(`${varName}=your_${varName.toLowerCase()}_here`);
    });
    process.exit(1);
  }
}

validateEnvironment();

// Network configuration
const NETWORKS = {
  "sonic-blaze": {
    id: "sonic-blaze",
    name: "Sonic Blaze Testnet",
    walletFile: "wallet_data_sonic_blaze.txt",
  },
  "ethereum-sepolia": {
    id: "ethereum-sepolia",
    name: "Ethereum Sepolia Testnet",
    walletFile: "wallet_data_ethereum_sepolia.txt",
  },
  "polygon-amoy": {
    id: "polygon-amoy",
    name: "Polygon Amoy Testnet",
    walletFile: "wallet_data_polygon_amoy.txt",
  },
  "base-sepolia": {
    id: "base-sepolia",
    name: "Base Sepolia Testnet",
    walletFile: "wallet_data_base_sepolia.txt",
  },
};

// Default network
const DEFAULT_NETWORK = "base-sepolia";

// Function to parse network from user input
function parseNetworkFromInput(input) {
  const normalizedInput = input.toLowerCase();

  if (normalizedInput.includes("sonic") || normalizedInput.includes("blaze")) {
    return "sonic-blaze";
  } else if (
    normalizedInput.includes("ethereum") ||
    normalizedInput.includes("eth sepolia")
  ) {
    return "ethereum-sepolia";
  } else if (
    normalizedInput.includes("polygon") ||
    normalizedInput.includes("amoy")
  ) {
    return "polygon-amoy";
  } else if (
    normalizedInput.includes("base sepolia") ||
    normalizedInput.includes("base")
  ) {
    return "base-sepolia";
  }

  return null;
}

// Agent state
let currentNetwork = DEFAULT_NETWORK;
let agent = null;
let agentConfig = null;

// Agent Initialization
async function initializeAgent(networkId = DEFAULT_NETWORK) {
  try {
    const network = NETWORKS[networkId] || NETWORKS[DEFAULT_NETWORK];
    console.log(
      `Initializing agent for network: ${network.name} (${network.id})`
    );

    const llm = new ChatGroq({
      model: "llama3-70b-8192",
      apiKey:
        process.env.GROQ_API_KEY ||
        "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",
    });

    // Load wallet data if it exists
    let walletDataStr = null;
    if (fs.existsSync(network.walletFile)) {
      try {
        walletDataStr = fs.readFileSync(network.walletFile, "utf-8");
      } catch (e) {
        console.error(`Error reading wallet data for ${network.name}: `, e);
      }
    }

    const config = {
      apiKeyName: process.env.CDP_API_KEY_NAME,
      apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(
        /\\n/g,
        "\n"
      ),
      cdpWalletData: walletDataStr || undefined,
      networkId: network.id,
    };

    const walletProvider = await CdpWalletProvider.configureWithWallet(config);

    const agentkit = await AgentKit.from({
      walletProvider,
      actionProviders: [
        wethActionProvider(),
        pythActionProvider(),
        walletActionProvider(),
        erc20ActionProvider(),
        erc721ActionProvider(),
        cdpApiActionProvider({
          apiKeyName: process.env.CDP_API_KEY_NAME,
          apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(
            /\\n/g,
            "\n"
          ),
        }),
        cdpWalletActionProvider({
          apiKeyName: process.env.CDP_API_KEY_NAME,
          apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(
            /\\n/g,
            "\n"
          ),
        }),
      ],
    });

    const tools = await getLangChainTools(agentkit);
    const memory = new MemorySaver();
    const agentConfig = {
      configurable: { thread_id: `CDP AgentKit on ${network.name}` },
    };

    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: memory,
      messageModifier: `
        You are a helpful blockchain agent that can interact with various networks using the Coinbase Developer Platform AgentKit.

        You are currently connected to the ${network.name} (${network.id}) network.

        You can understand when users want to switch networks. If a user mentions a specific network like "Ethereum Sepolia",
        "Polygon Amoy", "Sonic Blaze", or "Base Sepolia", you should inform them that you're connecting to that network
        and then continue with their request.

        You are empowered to interact onchain using your tools. If you need funds, you can request them from the faucet
        if you are on a testnet. If not, you can provide your wallet details and request funds from the user.

        Before executing your first action, get the wallet details to see what network you're on. If there is a 5XX (internal)
        HTTP error code, ask the user to try again later.

        If someone asks you to do something you can't do with your currently available tools, you must say so, and encourage
        them to implement it themselves using the CDP SDK + Agentkit, and recommend they go to docs.cdp.coinbase.com for more information.

        Be concise and helpful with your responses. Refrain from restating your tools' descriptions unless explicitly requested.

        When users ask about addresses, balances, or transactions, make sure to provide the relevant information for the current network.
        `,
    });

    // Save wallet data
    const exportedWallet = await walletProvider.exportWallet();
    fs.writeFileSync(network.walletFile, JSON.stringify(exportedWallet));

    // Update current network
    currentNetwork = network.id;

    return { agent, config: agentConfig, network };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

// Function to handle network switching
async function handleNetworkSwitch(input) {
  const detectedNetwork = parseNetworkFromInput(input);

  if (detectedNetwork && detectedNetwork !== currentNetwork) {
    console.log(
      `Network switch detected. Switching to ${NETWORKS[detectedNetwork].name}...`
    );
    const {
      agent: newAgent,
      config: newConfig,
      network,
    } = await initializeAgent(detectedNetwork);

    agent = newAgent;
    agentConfig = newConfig;
    currentNetwork = network.id;

    return {
      switched: true,
      network: network,
      message: `Switched to ${network.name} (${network.id}). `,
    };
  }

  return { switched: false };
}

async function runChatMode(initialAgent, initialConfig) {
  console.log("Starting chat mode... Type 'exit' to end.");

  agent = initialAgent;
  agentConfig = initialConfig;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      const userInput = await question("\nPrompt: ");

      if (userInput.toLowerCase() === "exit") {
        break;
      }

      // Check if network switch is requested
      const networkSwitch = await handleNetworkSwitch(userInput);

      // Create a modified input if network was switched
      const processedInput = networkSwitch.switched
        ? `${networkSwitch.message}${userInput}`
        : userInput;

      const stream = await agent.stream(
        { messages: [new HumanMessage(processedInput)] },
        agentConfig
      );

      for await (const chunk of stream) {
        if ("agent" in chunk) {
          console.log(chunk.agent.messages[0].content);
        } else if ("tools" in chunk) {
          console.log(chunk.tools.messages[0].content);
        }
        console.log("-------------------");
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

async function main() {
  try {
    // Initialize with default network
    const { agent: initialAgent, config: initialConfig } =
      await initializeAgent();

    // Display available networks
    console.log("\nAvailable networks:");
    Object.values(NETWORKS).forEach((network, index) => {
      console.log(
        `${index + 1}. ${network.name} ${
          network.id === DEFAULT_NETWORK ? "(default)" : ""
        }`
      );
    });

    console.log("\nStarting chat mode...");
    await runChatMode(initialAgent, initialConfig);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Start the agent when running directly
if (import.meta.url === new URL(import.meta.url).href) {
  console.log("Starting Agent...");
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
