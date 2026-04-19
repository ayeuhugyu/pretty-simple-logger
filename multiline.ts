import { Logger } from "./src/index";

const text = "some\ntext\nwith\n\nsome\nnewlines\n"

const log = new Logger();
log.info(text);
log.info("and some regular text with no newlines")