package org.voidcoin.wallet

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class ElectrumClient {
    companion object {
        private const val TAG = "ElectrumClient"
        private const val MAX_RETRIES = 3
        private const val RETRY_DELAY_MS = 1000L // 1 second delay between retries

        /** Debug-only logging — stripped from release builds */
        private fun logD(tag: String, msg: String) {
            if (BuildConfig.DEBUG) Log.d(tag, msg)
        }
        
        // BCH2 Electrum servers — SSL (port 50002) so SPKI cert pinning is active
        val hardcodedPeers = listOf(
            ElectrumServer("electrum.bch2.org", 50002, true)
        )
    }

    private var socket: Socket? = null
    private var outputStream: OutputStream? = null
    private var inputReader: BufferedReader? = null
    private var context: Context? = null
    private var networkStatusListener: NetworkStatusListener? = null
    
    data class ElectrumServer(val host: String, val port: Int, val isSsl: Boolean)
    
    /**
     * Initialize ElectrumClient with application context for network checks
     */
    fun initialize(context: Context) {
        Log.i(TAG, "Initializing ElectrumClient with context")
        this.context = context.applicationContext
    }
    
    /**
     * Set a listener for network status changes
     */
    fun setNetworkStatusListener(listener: NetworkStatusListener) {
        logD(TAG, "Setting network status listener")
        this.networkStatusListener = listener
    }
    
    /**
     * Interface for listening to network status changes
     */
    interface NetworkStatusListener {
        fun onNetworkStatusChanged(isConnected: Boolean)
        fun onConnectionError(error: String)
        fun onConnectionSuccess()
    }
    
    /**
     * Check if the device has network connectivity
     */
    private fun isNetworkAvailable(): Boolean {
        val hasNetwork = context?.let { NetworkUtils.isNetworkAvailable(it) } ?: false
        logD(TAG, "Network available: $hasNetwork")
        return hasNetwork
    }
    
    /**
     * Connect to the next available Electrum server with network checks
     */
    suspend fun connectToNextAvailable(
        servers: List<ElectrumServer> = hardcodedPeers,
        validateCertificates: Boolean = true,
        connectTimeout: Long = 5000 // 5 seconds
    ): Boolean = withContext(Dispatchers.IO) {
        val startTime = System.currentTimeMillis()
        Log.i(TAG, "Starting connection attempt to Electrum server. Server count: ${servers.size}")
        
        // Check network availability first
        if (!isNetworkAvailable()) {
            Log.e(TAG, "No network connection available. Connection attempt aborted.")
            networkStatusListener?.onNetworkStatusChanged(false)
            return@withContext false
        }
        
        var connected = false
        var lastError: Exception? = null
        
        for (serverIndex in servers.indices) {
            val server = servers[serverIndex]
            if (connected) break
            
            logD(TAG, "Trying server ${serverIndex+1}/${servers.size}: ${server.host}:${server.port} (SSL: ${server.isSsl})")
            
            // Try up to MAX_RETRIES times per server
            for (attempt in 1..MAX_RETRIES) {
                try {
                    logD(TAG, "Connection attempt $attempt/$MAX_RETRIES to ${server.host}:${server.port} (SSL: ${server.isSsl})")
                    val attemptStartTime = System.currentTimeMillis()
                    
                    withTimeout(connectTimeout) {
                        if (connect(server, validateCertificates)) {
                            val attemptDuration = System.currentTimeMillis() - attemptStartTime
                            Log.i(TAG, "Successfully connected to ${server.host}:${server.port} in ${attemptDuration}ms")
                            networkStatusListener?.onConnectionSuccess()
                            connected = true
                        } else {
                            Log.w(TAG, "Failed to connect to ${server.host}:${server.port} - connect() returned false")
                        }
                    }
                } catch (e: TimeoutCancellationException) {
                    lastError = e
                    Log.e(TAG, "Connection to ${server.host}:${server.port} timed out after ${connectTimeout}ms (attempt $attempt)")
                    if (attempt < MAX_RETRIES) {
                        logD(TAG, "Retrying after ${RETRY_DELAY_MS}ms delay")
                        delay(RETRY_DELAY_MS)
                    }
                } catch (e: Exception) {
                    lastError = e
                    Log.e(TAG, "Error connecting to ${server.host}:${server.port} (attempt $attempt): ${e.message}")
                    if (attempt < MAX_RETRIES) {
                        logD(TAG, "Retrying after ${RETRY_DELAY_MS}ms delay")
                        delay(RETRY_DELAY_MS)
                    }
                }
            }
        }
        
        val totalDuration = System.currentTimeMillis() - startTime
        
        if (!connected) {
            Log.e(TAG, "Failed to connect to any Electrum server after ${totalDuration}ms. Last error: ${lastError?.message}")
            networkStatusListener?.onConnectionError("Failed to connect to any Electrum server: ${lastError?.message}")
        } else {
            Log.i(TAG, "Successfully connected to an Electrum server in ${totalDuration}ms")
        }
        
        connected
    }
    
    /**
     * Log the server details upon successful connection
     */
    private fun logServerDetails(server: ElectrumServer) {
        Log.i(TAG, "Connected to Electrum server: ${server.host}:${server.port} (SSL: ${server.isSsl})")
    }

    /**
     * Connect to a specific Electrum server with network check
     */
    suspend fun connect(
        server: ElectrumServer,
        validateCertificates: Boolean = true
    ): Boolean = withContext(Dispatchers.IO) {
        val startTime = System.currentTimeMillis()
        logD(TAG, "Attempting direct connection to ${server.host}:${server.port} (SSL: ${server.isSsl})")

        var result = false

        if (!isNetworkAvailable()) {
            Log.e(TAG, "Cannot connect to ${server.host}: No network connection available")
            networkStatusListener?.onNetworkStatusChanged(false)
            return@withContext false
        }

        try {
            close() // Close any existing connection
            logD(TAG, "Creating ${if (server.isSsl) "SSL " else "TCP "}socket to ${server.host}:${server.port}")

            socket = if (server.isSsl) {
                createSslSocket(server.host, server.port, validateCertificates)
            } else {
                Socket().apply { connect(java.net.InetSocketAddress(server.host, server.port), 10000) }
            }

            logD(TAG, "Socket created successfully. Setting timeout and getting streams.")
            socket?.soTimeout = 10000 // 10 seconds read timeout
            outputStream = socket?.getOutputStream()
            inputReader = BufferedReader(InputStreamReader(socket?.getInputStream()))

            // Testing the connection with simple version request
            val versionRequest = "{\"id\": 0, \"method\": \"server.version\", \"params\": [\"BCH2Wallet\", \"1.4\"]}\n"
            logD(TAG, "Sending version request to verify connection")
            send(versionRequest.toByteArray())

            val response = receive()
            if (response.isNotEmpty()) {
                val responseStr = String(response)
                logD(TAG, "Received server version response: $responseStr")
                networkStatusListener?.onNetworkStatusChanged(true)
                logServerDetails(server) // Log server details here
                result = true
            } else {
                Log.w(TAG, "Empty response from server when verifying connection")
                networkStatusListener?.onConnectionError("Empty response from server")
                close()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error connecting to Electrum server: ${e.javaClass.simpleName} - ${e.message}")
            networkStatusListener?.onConnectionError("Error connecting: ${e.message}")
            close()
        }

        val duration = System.currentTimeMillis() - startTime
        logD(TAG, "Connection attempt to ${server.host}:${server.port} completed in ${duration}ms, result: $result")

        result
    }
    
    /**
     * Send data to the connected Electrum server with network check
     */
    suspend fun send(data: ByteArray): Boolean = withContext(Dispatchers.IO) {
        val message = String(data).trim()
        val messagePreview = if (message.length > 100) message.substring(0, 100) + "..." else message
        logD(TAG, "Sending to Electrum: $messagePreview")
        
        if (!isNetworkAvailable()) {
            Log.e(TAG, "Cannot send data: No network connection available")
            networkStatusListener?.onNetworkStatusChanged(false)
            return@withContext false
        }
        
        try {
            outputStream?.write(data)
            outputStream?.flush()
            logD(TAG, "Data sent successfully")
            return@withContext true
        } catch (e: Exception) {
            Log.e(TAG, "Error sending data to Electrum server: ${e.javaClass.simpleName} - ${e.message}")
            networkStatusListener?.onConnectionError("Error sending data: ${e.message}")
            return@withContext false
        }
    }
    
    /**
     * Receive data from the connected Electrum server with timeout handling
     */
    suspend fun receive(): ByteArray = withContext(Dispatchers.IO) {
        logD(TAG, "Waiting to receive data from Electrum server")
        val startTime = System.currentTimeMillis()
        
        try {
            val response = StringBuilder()

            try {
                // Electrum JSON-RPC uses newline-delimited JSON — read a single line
                val line = inputReader?.readLine()
                if (line != null) {
                    response.append(line)
                }
            } catch (e: SocketTimeoutException) {
                Log.e(TAG, "Socket read timed out after ${System.currentTimeMillis() - startTime}ms")
                networkStatusListener?.onConnectionError("Socket read timed out")
            }
            
            val responseData = response.toString().toByteArray()
            val responsePreview = if (response.length > 100) response.substring(0, 100) + "..." else response.toString()
            
            if (responseData.isNotEmpty()) {
                val duration = System.currentTimeMillis() - startTime
                logD(TAG, "Received data (${responseData.size} bytes) in ${duration}ms: $responsePreview")
            } else {
                Log.w(TAG, "Received empty response from Electrum server")
            }
            
            return@withContext responseData
        } catch (e: Exception) {
            Log.e(TAG, "Error receiving data from Electrum server: ${e.javaClass.simpleName} - ${e.message}")
            networkStatusListener?.onConnectionError("Error receiving data: ${e.message}")
            return@withContext ByteArray(0)
        }
    }
    
    /**
     * Close the connection to the Electrum server
     */
    fun close() {
        try {
            inputReader?.close()
            outputStream?.close()
            socket?.close()
        } catch (e: Exception) {
            Log.e(TAG, "Error closing Electrum connection", e)
        } finally {
            inputReader = null
            outputStream = null
            socket = null
        }
    }
    
    // Known BCH2 Electrum server hosts — only these may skip full cert validation
    private val BCH2_ELECTRUM_HOSTS = setOf(
        "electrum.bch2.org",
        "144.202.73.66",
        "45.32.138.29",
        "108.61.190.83",
        "64.176.215.202",
        "139.180.132.24",
    )

    // SPKI SHA-256 fingerprints for BCH2 Electrum servers (hex, lowercase).
    // Pins the public key rather than the full cert — survives certificate renewals
    // as long as the key pair is unchanged. Update this set when keys rotate.
    private val PINNED_ELECTRUM_SPKI_SHA256 = setOf(
        "ad71c6307a433d08934cc5b71ae9e310052d0937cb83e663e5dd082d76551684", // 144.202.73.66 / electrum.bch2.org
    )

    /**
     * Create an SSL socket with certificate validation control.
     * When validateCertificates is false, self-signed certificates are accepted
     * ONLY for known BCH2 Electrum server hosts. Unknown hosts always use full
     * validation to prevent MITM attacks.
     */
    private fun createSslSocket(host: String, port: Int, validateCertificates: Boolean = true): SSLSocket {
        val sslContext = SSLContext.getInstance("TLS")
        if (validateCertificates || host !in BCH2_ELECTRUM_HOSTS) {
            // Use default trust manager for proper certificate validation.
            // Also enforced for unknown hosts even if validateCertificates=false.
            if (!validateCertificates && host !in BCH2_ELECTRUM_HOSTS) {
                Log.w(TAG, "Certificate validation skip denied for unknown host: $host — using default validation")
            }
            sslContext.init(null, null, null)
        } else {
            // Accept certificates for known BCH2 Electrum servers, pinned by SPKI SHA-256.
            // Pins the public key so the pin survives cert renewals without app updates.
            val trustBCH2Certs = arrayOf<TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    if (chain.isNullOrEmpty()) throw CertificateException("Empty certificate chain from $host")
                    chain[0].checkValidity()
                    val spkiHash = MessageDigest.getInstance("SHA-256")
                        .digest(chain[0].publicKey.encoded)
                        .joinToString("") { "%02x".format(it) }
                    if (spkiHash !in PINNED_ELECTRUM_SPKI_SHA256) {
                        throw CertificateException("Cert public key not in pinned set for $host (SPKI=$spkiHash)")
                    }
                }
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            })
            sslContext.init(null, trustBCH2Certs, SecureRandom())
        }

        val factory: SSLSocketFactory = sslContext.socketFactory
        val sslSocket = factory.createSocket(host, port) as SSLSocket
        // Restrict to TLS 1.2+ to prevent protocol downgrade attacks
        sslSocket.enabledProtocols = arrayOf("TLSv1.2", "TLSv1.3")
        // Enable hostname verification for non-BCH2 hosts (standard CA-validated connections)
        if (validateCertificates || host !in BCH2_ELECTRUM_HOSTS) {
            sslSocket.sslParameters = sslSocket.sslParameters.apply {
                endpointIdentificationAlgorithm = "HTTPS"
            }
        }
        return sslSocket
    }

    private fun getNextPeer(): ElectrumServer {
        val savedPeer = getSavedPeer()
        return if (savedPeer != null) {
            logD(TAG, "Using saved peer: ${savedPeer.host}:${savedPeer.port} (SSL: ${savedPeer.isSsl})")
            savedPeer
        } else {
            logD(TAG, "No saved peer found. Using default hardcoded peers.")
            hardcodedPeers.random()
        }
    }

 
    private fun getSavedPeer(): ElectrumServer? {
        // implement later
        return null
    }
}
