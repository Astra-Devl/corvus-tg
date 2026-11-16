/** Skema lapisan MTProto (service). ID dihitung dari definisi (CRC32). */
export const SERVICE_TL = `
resPQ nonce:int128 server_nonce:int128 pq:bytes server_public_key_fingerprints:Vector<long> = ResPQ;
p_q_inner_data_dc pq:bytes p:bytes q:bytes nonce:int128 server_nonce:int128 new_nonce:int256 dc:int = P_Q_inner_data;
server_DH_params_fail nonce:int128 server_nonce:int128 new_nonce_hash:int128 = Server_DH_Params;
server_DH_params_ok nonce:int128 server_nonce:int128 encrypted_answer:bytes = Server_DH_Params;
server_DH_inner_data nonce:int128 server_nonce:int128 g:int dh_prime:bytes g_a:bytes server_time:int = Server_DH_inner_data;
client_DH_inner_data nonce:int128 server_nonce:int128 retry_id:long g_b:bytes = Client_DH_Inner_Data;
dh_gen_ok nonce:int128 server_nonce:int128 new_nonce_hash1:int128 = Set_client_DH_params_answer;
dh_gen_retry nonce:int128 server_nonce:int128 new_nonce_hash2:int128 = Set_client_DH_params_answer;
dh_gen_fail nonce:int128 server_nonce:int128 new_nonce_hash3:int128 = Set_client_DH_params_answer;
rpc_error error_code:int error_message:string = RpcError;
msgs_ack msg_ids:Vector<long> = MsgsAck;
bad_msg_notification bad_msg_id:long bad_msg_seqno:int error_code:int = BadMsgNotification;
bad_server_salt bad_msg_id:long bad_msg_seqno:int error_code:int new_server_salt:long = BadMsgNotification;
new_session_created first_msg_id:long unique_id:long server_salt:long = NewSession;
pong msg_id:long ping_id:long = Pong;
msg_detailed_info msg_id:long answer_msg_id:long bytes:int status:int = MsgDetailedInfo;
msg_new_detailed_info answer_msg_id:long bytes:int status:int = MsgDetailedInfo;
---functions---
req_pq_multi nonce:int128 = ResPQ;
req_DH_params nonce:int128 server_nonce:int128 p:bytes q:bytes public_key_fingerprint:long encrypted_data:bytes = Server_DH_Params;
set_client_DH_params nonce:int128 server_nonce:int128 encrypted_data:bytes = Set_client_DH_params_answer;
ping ping_id:long = Pong;
ping_delay_disconnect ping_id:long disconnect_delay:int = Pong;
`
