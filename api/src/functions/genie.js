const { app } = require("@azure/functions");

// Configuration - set these in Azure Function App Application Settings
const DATABRICKS_HOST = process.env.DATABRICKS_HOST; // e.g., "https://adb-xxxxx.azuredatabricks.net"
const GENIE_SPACE_ID = process.env.GENIE_SPACE_ID;   // Your Genie Space ID
const DATABRICKS_PAT = process.env.DATABRICKS_PAT;   // Databricks Personal Access Token

const POLL_INTERVAL_MS = 2000;  // Poll every 2 seconds
const TIMEOUT_MS = 60000;       // 60 second timeout

/**
 * Get Databricks PAT token
 */
function getDatabricksToken() {
    if (!DATABRICKS_PAT) {
        throw new Error("DATABRICKS_PAT environment variable is not set");
    }
    return DATABRICKS_PAT;
}

/**
 * Make authenticated request to Databricks API
 */
async function databricksRequest(token, method, path, body = null) {
    const url = `${DATABRICKS_HOST}${path}`;
    const options = {
        method,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        }
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Databricks API error (${response.status}): ${errorText}`);
    }
    
    return response.json();
}

/**
 * Start a new Genie conversation
 */
async function startConversation(token, question) {
    const path = `/api/2.0/genie/spaces/${GENIE_SPACE_ID}/start-conversation`;
    return databricksRequest(token, "POST", path, { content: question });
}

/**
 * Send a follow-up message in an existing conversation
 */
async function createMessage(token, conversationId, question) {
    const path = `/api/2.0/genie/spaces/${GENIE_SPACE_ID}/conversations/${conversationId}/messages`;
    return databricksRequest(token, "POST", path, { content: question });
}

/**
 * Get message status and response
 */
async function getMessage(token, conversationId, messageId) {
    const path = `/api/2.0/genie/spaces/${GENIE_SPACE_ID}/conversations/${conversationId}/messages/${messageId}`;
    return databricksRequest(token, "GET", path);
}

/**
 * Poll for message completion with timeout
 */
async function waitForResponse(token, conversationId, messageId, startTime) {
    while (Date.now() - startTime < TIMEOUT_MS) {
        const message = await getMessage(token, conversationId, messageId);
        
        if (message.status === "COMPLETED") {
            // Extract text response from attachments
            let answer = "";
            if (message.attachments && message.attachments.length > 0) {
                for (const attachment of message.attachments) {
                    if (attachment.text && attachment.text.content) {
                        answer += attachment.text.content + "\n";
                    }
                }
            }
            return {
                success: true,
                answer: answer.trim() || "I found the information but couldn't generate a text response.",
                conversationId,
                messageId
            };
        }
        
        if (message.status === "FAILED") {
            return {
                success: false,
                error: message.error?.message || "The query failed to execute.",
                conversationId,
                messageId
            };
        }
        
        if (message.status === "CANCELLED") {
            return {
                success: false,
                error: "The query was cancelled.",
                conversationId,
                messageId
            };
        }
        
        // Still processing - wait and poll again
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    
    // Timeout reached
    return {
        success: false,
        error: "The query timed out. Please try a simpler question.",
        conversationId,
        messageId
    };
}

/**
 * Main API endpoint: POST /api/genie/ask
 */
app.http("ask", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "genie/ask",
    handler: async (request, context) => {
        try {
            // Validate configuration
            if (!DATABRICKS_HOST || !GENIE_SPACE_ID) {
                context.error("Missing DATABRICKS_HOST or GENIE_SPACE_ID configuration");
                return {
                    status: 500,
                    jsonBody: { 
                        success: false, 
                        error: "Server configuration error. Please contact the administrator." 
                    }
                };
            }
            
            // Parse request body
            const body = await request.json();
            const { question, conversationId } = body;
            
            if (!question || typeof question !== "string" || question.trim().length === 0) {
                return {
                    status: 400,
                    jsonBody: { 
                        success: false, 
                        error: "Please provide a question." 
                    }
                };
            }
            
            // Limit question length
            if (question.length > 1000) {
                return {
                    status: 400,
                    jsonBody: { 
                        success: false, 
                        error: "Question is too long. Please keep it under 1000 characters." 
                    }
                };
            }
            
            const startTime = Date.now();
            
            // Get Databricks PAT token
            context.log("Authenticating with Databricks via PAT...");
            const token = getDatabricksToken();
            
            let responseConversationId;
            let messageId;
            
            if (conversationId) {
                // Continue existing conversation
                context.log(`Continuing conversation ${conversationId}`);
                const messageResponse = await createMessage(token, conversationId, question.trim());
                responseConversationId = conversationId;
                messageId = messageResponse.message_id;
            } else {
                // Start new conversation
                context.log("Starting new Genie conversation");
                const convResponse = await startConversation(token, question.trim());
                responseConversationId = convResponse.conversation.id;
                messageId = convResponse.message.message_id;
            }
            
            // Poll for response
            context.log(`Waiting for response (message: ${messageId})...`);
            const result = await waitForResponse(token, responseConversationId, messageId, startTime);
            
            context.log(`Response received: success=${result.success}`);
            
            return {
                status: result.success ? 200 : 500,
                jsonBody: result
            };
            
        } catch (error) {
            context.error("Error processing Genie request:", error.message);
            
            return {
                status: 500,
                jsonBody: { 
                    success: false, 
                    error: "An error occurred while processing your question. Please try again."
                }
            };
        }
    }
});
