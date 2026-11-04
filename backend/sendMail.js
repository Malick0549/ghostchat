import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'abdulaiabdulmalick@gmail.com', // CHANGE TO YOUR GMAIL
    pass: 'snzc xhrg ntsb pmgo'  // CHANGE TO YOUR 16-LETTER APP PASSWORD
  }
});

export async function sendVerificationEmail(toEmail, code) {
  await transporter.sendMail({
    from: 'GostChat <abdulaiabdulmalick@gmail.com>',
    to: toEmail,
    subject: 'Verify your GostChat account',
    html: `<h1>Your code is ${code}</h1>`
  });
  console.log('Email sent to', toEmail);
}