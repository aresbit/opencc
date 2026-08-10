/** CodeAct OCaml helper module generator. */

import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { getCodeActBaseDir } from './codeActBuiltins.js'

const VERSION = '1'

function source(): string {
  return `let workspace () =
  match Sys.getenv_opt "CODEACT_WORKSPACE" with
  | Some path -> path
  | None -> Sys.getcwd ()

let protect ~finally f =
  match f () with
  | value -> finally (); value
  | exception exn -> finally (); raise exn

let read_file path =
  let channel = open_in_bin path in
  protect ~finally:(fun () -> close_in_noerr channel) (fun () ->
    really_input_string channel (in_channel_length channel))

let write_file path content =
  let channel = open_out_bin path in
  protect ~finally:(fun () -> close_out_noerr channel) (fun () ->
    output_string channel content)

type command_result = {
  status : Unix.process_status;
  stdout : string;
}

let run program args =
  let read_fd, write_fd = Unix.pipe () in
  let argv = Array.of_list (program :: args) in
  let pid = Unix.create_process program argv Unix.stdin write_fd Unix.stderr in
  Unix.close write_fd;
  let channel = Unix.in_channel_of_descr read_fd in
  let output = Buffer.create 256 in
  (try while true do Buffer.add_char output (input_char channel) done
   with End_of_file -> ());
  close_in_noerr channel;
  let _, status = Unix.waitpid [] pid in
  { status; stdout = Buffer.contents output }
`
}

export function ensureCodeActBuiltinsOcamlSync(): string {
  const dir = join(getCodeActBaseDir(), 'builtins_ocaml')
  mkdirSync(dir, { recursive: true })
  const versionPath = join(dir, '.version')
  const stale = !existsSync(join(dir, 'codeact.ml')) ||
    !existsSync(versionPath) ||
    readFileSync(versionPath, 'utf-8').trim() !== VERSION
  if (stale) {
    writeFileSync(join(dir, 'codeact.ml'), source(), 'utf-8')
    writeFileSync(versionPath, VERSION, 'utf-8')
  }
  return dir
}
